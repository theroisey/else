//go:build integration

package integration

import (
	"context"
	"crypto/rand"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/database"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/migrations"
)

type fixture struct {
	ctx   context.Context
	admin *pgx.Conn
	URL   string
	name  string
	roles []string
}

// Integration tests create and remove only their uniquely named databases/roles.
// An explicitly supplied disposable PostgreSQL admin URL is mandatory.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	raw := os.Getenv("TEST_DATABASE_URL")
	c, err := config.LoadDatabase(func(string) (string, bool) { return raw, raw != "" }, "TEST_DATABASE_URL")
	if err != nil {
		t.Fatal("set TEST_DATABASE_URL to a disposable PostgreSQL admin database; integration tests never silently skip")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	admin, err := pgx.Connect(ctx, c.URL)
	if err != nil {
		cancel()
		t.Fatal("disposable PostgreSQL admin connection failed")
	}
	f := &fixture{ctx: ctx, admin: admin, name: "roisey_test_" + rand.Text()[:12]}
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{f.name}.Sanitize()); err != nil {
		admin.Close(ctx)
		cancel()
		t.Fatal(err)
	}
	u, _ := url.Parse(raw)
	u.Path = "/" + f.name
	f.URL = u.String()
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if _, err := admin.Exec(cleanup, "DROP DATABASE "+pgx.Identifier{f.name}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Error("disposable database cleanup failed")
		}
		for _, role := range f.roles {
			if _, err := admin.Exec(cleanup, "DROP ROLE "+pgx.Identifier{role}.Sanitize()); err != nil {
				t.Error("disposable role cleanup failed")
			}
		}
		_ = admin.Close(cleanup)
		cancel()
	})
	return f
}

func settings(t *testing.T, raw string) config.Database {
	t.Helper()
	c, err := config.LoadDatabase(func(string) (string, bool) { return raw, true }, "TEST_DATABASE_URL")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func provider(t *testing.T, f *fixture) *goose.Provider {
	return providerFiles(t, f, migrations.Files)
}

func providerFiles(t *testing.T, f *fixture, files fs.FS) *goose.Provider {
	t.Helper()
	db, err := database.OpenMigration(f.ctx, settings(t, f.URL))
	if err != nil {
		t.Fatal("migration connection failed")
	}
	t.Cleanup(func() { _ = db.Close() })
	p, err := database.MigrationProvider(db, files)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func connection(t *testing.T, f *fixture) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(f.ctx, f.URL)
	if err != nil {
		t.Fatal("disposable database connection failed")
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func TestMigrationRoundTripAndUTC(t *testing.T) {
	f := newFixture(t)
	p := provider(t, f)
	expectedApplied := []int{6, 6, 5, 4, 3, 2, 1, 0, 6}
	for step, direction := range []string{"up", "up", "down", "down", "down", "down", "down", "down", "up"} {
		var err error
		if direction == "up" {
			_, err = p.Up(f.ctx)
		} else {
			_, err = p.Down(f.ctx)
		}
		if err != nil {
			t.Fatal(err)
		}
		rows, err := p.Status(f.ctx)
		if err != nil || len(rows) != 6 {
			t.Fatal("migration status failed")
		}
		for index, row := range rows {
			want := goose.StatePending
			if index < expectedApplied[step] {
				want = goose.StateApplied
			}
			if row.State != want {
				t.Fatal("incorrect migration state")
			}
		}
	}
	pool, err := database.Open(f.ctx, settings(t, f.URL))
	if err != nil {
		t.Fatal("pool startup failed")
	}
	defer pool.Close()
	var zone string
	if err := pool.QueryRow(f.ctx, "SHOW TimeZone").Scan(&zone); err != nil || zone != "UTC" {
		t.Fatal("runtime timezone is not UTC")
	}
	conn := connection(t, f)
	var schema bool
	if err := conn.QueryRow(f.ctx, "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='app')").Scan(&schema); err != nil || !schema {
		t.Fatal("baseline schema missing")
	}
	db, err := database.OpenMigration(f.ctx, settings(t, f.URL))
	if err != nil {
		t.Fatal("migration connection failed")
	}
	defer db.Close()
	if err := db.QueryRowContext(f.ctx, "SHOW TimeZone").Scan(&zone); err != nil || zone != "UTC" {
		t.Fatal("migration timezone is not UTC")
	}
}

func TestFailedMigrationRollsBackAndPreservesVersion(t *testing.T) {
	f := newFixture(t)
	p := providerFiles(t, f, fstest.MapFS{"000001_create_app_schema.sql": {Data: mustReadBaseline(t)}})
	if _, err := p.Up(f.ctx); err != nil {
		t.Fatal(err)
	}
	sqlDB, err := database.OpenMigration(f.ctx, settings(t, f.URL))
	if err != nil {
		t.Fatal("migration connection failed")
	}
	defer sqlDB.Close()
	files := fstest.MapFS{
		"000001_create_app_schema.sql": {Data: mustReadBaseline(t)},
		"000002_failure.sql":           {Data: []byte("-- +goose Up\nCREATE TABLE app.failure_probe(id integer);\nSELECT 1/0;\n-- +goose Down\nDROP TABLE app.failure_probe;\n")},
	}
	failing, err := database.MigrationProvider(sqlDB, files)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := failing.Up(f.ctx); err == nil {
			t.Fatal("failed migration accepted")
		}
	}
	conn := connection(t, f)
	var object *string
	var version int
	if err := conn.QueryRow(f.ctx, "SELECT to_regclass('app.failure_probe')::text").Scan(&object); err != nil || object != nil {
		t.Fatal("failed DDL was not rolled back")
	}
	if err := conn.QueryRow(f.ctx, "SELECT max(version_id) FROM public.goose_db_version WHERE is_applied").Scan(&version); err != nil || version != 1 {
		t.Fatal("failed migration advanced version")
	}
}

func mustReadBaseline(t *testing.T) []byte {
	t.Helper()
	data, err := migrations.Files.ReadFile("000001_create_app_schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestBaselineRollbackRefusesToCascadeThroughData(t *testing.T) {
	f := newFixture(t)
	p := providerFiles(t, f, fstest.MapFS{"000001_create_app_schema.sql": {Data: mustReadBaseline(t)}})
	if _, err := p.Up(f.ctx); err != nil {
		t.Fatal(err)
	}
	conn := connection(t, f)
	if _, err := conn.Exec(f.ctx, "CREATE TABLE app.keep_data(id integer PRIMARY KEY); INSERT INTO app.keep_data VALUES (7)"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Down(f.ctx); err == nil {
		t.Fatal("rollback destroyed a nonempty schema")
	}
	var id int
	if err := conn.QueryRow(f.ctx, "SELECT id FROM app.keep_data").Scan(&id); err != nil || id != 7 {
		t.Fatal("existing data was not preserved")
	}
	rows, err := p.Status(f.ctx)
	if err != nil || rows[0].State != goose.StateApplied {
		t.Fatal("failed rollback advanced version")
	}
}

func TestMigrationLockCancellationAndRecovery(t *testing.T) {
	f := newFixture(t)
	p := provider(t, f)
	blocker := connection(t, f)
	if _, err := blocker.Exec(f.ctx, "SELECT pg_advisory_lock($1)", lock.DefaultLockID); err != nil {
		t.Fatal(err)
	}
	bounded, cancel := context.WithTimeout(f.ctx, 100*time.Millisecond)
	_, err := p.Up(bounded)
	cancel()
	if err == nil {
		t.Fatal("migration ignored another session's lock")
	}
	if _, err := blocker.Exec(f.ctx, "SELECT pg_advisory_unlock($1)", lock.DefaultLockID); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Up(f.ctx); err != nil {
		t.Fatal("migration did not recover after contention")
	}
}

func (f *fixture) role(t *testing.T) (string, string) {
	t.Helper()
	name := "roisey_role_" + rand.Text()[:12]
	password := rand.Text()
	if _, err := f.admin.Exec(f.ctx, "CREATE ROLE "+pgx.Identifier{name}.Sanitize()+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '"+password+"'"); err != nil {
		t.Fatal("disposable role creation failed")
	}
	f.roles = append(f.roles, name)
	u, _ := url.Parse(f.URL)
	u.User = url.UserPassword(name, password)
	return name, u.String()
}

func TestRuntimeRoleCannotChangeSchemaOrMigrationHistory(t *testing.T) {
	f := newFixture(t)
	migrator, migrationURL := f.role(t)
	runtime, runtimeURL := f.role(t)
	conn := connection(t, f)
	for _, sql := range []string{
		"REVOKE ALL ON DATABASE " + pgx.Identifier{f.name}.Sanitize() + " FROM PUBLIC",
		"GRANT CONNECT, CREATE ON DATABASE " + pgx.Identifier{f.name}.Sanitize() + " TO " + pgx.Identifier{migrator}.Sanitize(),
		"GRANT CONNECT ON DATABASE " + pgx.Identifier{f.name}.Sanitize() + " TO " + pgx.Identifier{runtime}.Sanitize(),
		"REVOKE ALL ON SCHEMA public FROM PUBLIC",
		"GRANT USAGE, CREATE ON SCHEMA public TO " + pgx.Identifier{migrator}.Sanitize(),
	} {
		if _, err := conn.Exec(f.ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	db, err := database.OpenMigration(f.ctx, settings(t, migrationURL))
	if err != nil {
		t.Fatal("migrator connection failed")
	}
	defer db.Close()
	p, err := database.MigrationProvider(db, migrations.Files)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Up(f.ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(f.ctx, "GRANT USAGE ON SCHEMA app TO "+pgx.Identifier{runtime}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(f.ctx, settings(t, runtimeURL))
	if err != nil {
		t.Fatal("runtime connection failed")
	}
	defer pool.Close()
	if err := pool.Ping(f.ctx); err != nil {
		t.Fatal("runtime cannot check connectivity")
	}
	for _, sql := range []string{"CREATE SCHEMA forbidden", "CREATE TABLE app.forbidden(id integer)", "CREATE TABLE public.forbidden(id integer)", "UPDATE public.goose_db_version SET version_id=999", "SELECT * FROM public.goose_db_version"} {
		if _, err := pool.Exec(f.ctx, sql); err == nil {
			t.Fatal("runtime role gained schema or migration access")
		}
	}
}

func TestRealReadinessTracksDatabaseOutageAndRecovery(t *testing.T) {
	f := newFixture(t)
	pool, err := database.Open(f.ctx, settings(t, f.URL))
	if err != nil {
		t.Fatal("pool startup failed")
	}
	defer pool.Close()
	c, _ := config.Load(func(string) (string, bool) { return "", false })
	c.ReadinessTimeout = 300 * time.Millisecond
	s, err := httpapi.New(c, slog.New(slog.NewJSONHandler(io.Discard, nil)), pool.Ping)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(f.ctx)
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, listener) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	client := &http.Client{Timeout: time.Second}
	base := "http://" + listener.Addr().String()
	check := func(path string, status int) {
		t.Helper()
		response, err := client.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != status {
			t.Fatalf("%s status %d, want %d", path, response.StatusCode, status)
		}
	}
	check("/ready", 200)
	if _, err := f.admin.Exec(f.ctx, "ALTER DATABASE "+pgx.Identifier{f.name}.Sanitize()+" ALLOW_CONNECTIONS false"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(f.ctx, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", f.name); err != nil {
		t.Fatal(err)
	}
	check("/ready", 503)
	check("/health", 200)
	if _, err := f.admin.Exec(f.ctx, "ALTER DATABASE "+pgx.Identifier{f.name}.Sanitize()+" ALLOW_CONNECTIONS true"); err != nil {
		t.Fatal(err)
	}
	check("/ready", 200)
}

func TestStartupRejectsUnavailableDatabaseWithinDeadline(t *testing.T) {
	f := newFixture(t)
	c := settings(t, f.URL)
	u, _ := url.Parse(c.URL)
	u.Path = "/roisey_test_missing_" + rand.Text()[:12]
	c.URL = u.String()
	c.ConnectTimeout = 200 * time.Millisecond
	started := time.Now()
	pool, err := database.Open(f.ctx, c)
	if err == nil || pool != nil {
		if pool != nil {
			pool.Close()
		}
		t.Fatal("missing database accepted")
	}
	if time.Since(started) > time.Second {
		t.Fatal("startup connection failure was not bounded")
	}
}
