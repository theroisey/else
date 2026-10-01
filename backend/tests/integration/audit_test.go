//go:build integration

package integration

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/database"
	httpapi "github.com/theroisey/else/backend/internal/http"
)

const fixtureID = "11111111-1111-4111-8111-111111111111"
const secondFixtureID = "11111111-1111-4111-8111-111111111112"

func auditEvent() audit.Event {
	exists := true
	revision := int64(1)
	return audit.Event{Actor: audit.Actor{Kind: audit.System}, Action: audit.Created,
		ResourceKind: "fixture", ResourceID: fixtureID,
		After: &audit.Snapshot{Exists: &exists, Revision: &revision}, Metadata: audit.Metadata{Source: audit.CLI}}
}

const auditColumns = "(actor_kind, actor_user_id, event_name, resource_kind, resource_id, client_id, request_id, before_state, after_state, metadata)"

func auditFixture(t *testing.T) (*fixture, *pgx.Conn, *pgxpool.Pool, string) {
	t.Helper()
	f := newFixture(t)
	if _, err := provider(t, f).Up(f.ctx); err != nil {
		t.Fatal(err)
	}
	admin := connection(t, f)
	role, raw := f.role(t)
	quoted := pgx.Identifier{role}.Sanitize()
	for _, sql := range []string{
		"GRANT USAGE ON SCHEMA app TO " + quoted,
		"GRANT INSERT " + auditColumns + " ON app.audit_events TO " + quoted,
		"GRANT EXECUTE ON FUNCTION app.audit_snapshot_allowed(jsonb) TO " + quoted,
		"CREATE TABLE app.audit_business_fixture (id uuid PRIMARY KEY)",
		"GRANT INSERT ON app.audit_business_fixture TO " + quoted,
	} {
		if _, err := admin.Exec(f.ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	pool, err := database.Open(f.ctx, settings(t, raw))
	if err != nil {
		t.Fatal("audit runtime connection failed")
	}
	t.Cleanup(pool.Close)
	return f, admin, pool, quoted
}

func insertBusiness(ctx context.Context, q audit.Queries) (audit.Event, error) {
	// The capability cannot be type-asserted to pgx.Tx to commit independently.
	if _, exposed := q.(pgx.Tx); exposed {
		return audit.Event{}, errors.New("transaction lifecycle exposed")
	}
	_, err := q.Exec(ctx, "INSERT INTO app.audit_business_fixture VALUES ($1::uuid)", fixtureID)
	return auditEvent(), err
}

func assertCounts(t *testing.T, f *fixture, admin *pgx.Conn, business, history int) {
	t.Helper()
	var b, a int
	if err := admin.QueryRow(f.ctx, "SELECT (SELECT count(*) FROM app.audit_business_fixture), (SELECT count(*) FROM app.audit_events)").Scan(&b, &a); err != nil || b != business || a != history {
		t.Fatalf("partial writes: business=%d history=%d, expected %d/%d; %v", b, a, business, history, err)
	}
}

func TestAuditCommitAndHTTPCorrelation(t *testing.T) {
	f, admin, pool, _ := auditFixture(t)
	var mutationError error
	handler := httpapi.RequestMiddleware(slog.New(slog.NewJSONHandler(io.Discard, nil)), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mutationError = audit.WithTransaction(r.Context(), pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
			e, err := insertBusiness(ctx, q)
			e.Metadata.Source = audit.HTTP
			return e, err
		})
		w.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequest("POST", "/synthetic-fixture", strings.NewReader(`{"actor":"spoof","password":"secret"}`)).WithContext(f.ctx)
	request.Header.Set("X-Request-ID", "spoofed-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if mutationError != nil {
		t.Fatal(mutationError)
	}
	assertCounts(t, f, admin, 1, 1)
	var id, requestID, name, kind, resource, actor, before, after, metadata string
	var occurred time.Time
	var actorID, clientID *string
	if err := admin.QueryRow(f.ctx, `SELECT id::text, request_id, event_name, resource_kind, resource_id::text,
		actor_kind, actor_user_id::text, client_id::text, before_state::text, after_state::text, metadata::text, occurred_at
		FROM app.audit_events`).Scan(&id, &requestID, &name, &kind, &resource, &actor, &actorID, &clientID, &before, &after, &metadata, &occurred); err != nil {
		t.Fatal(err)
	}
	if id == "" || requestID != response.Header().Get("X-Request-ID") || requestID == "spoofed-secret" ||
		name != "fixture.created" || kind != "fixture" || resource != fixtureID || actor != "system" || actorID != nil || clientID != nil ||
		before != "null" || after != `{"exists": true, "revision": 1}` || metadata != `{"source": "http"}` || time.Since(occurred) > time.Minute {
		t.Fatal("stored event lost safe values or correlation")
	}
	var zone string
	if err := pool.QueryRow(f.ctx, "SHOW TimeZone").Scan(&zone); err != nil || zone != "UTC" {
		t.Fatal("audit runtime is not UTC")
	}
}

func TestAuditMultipleEventsAreAtomic(t *testing.T) {
	for _, validSecond := range []bool{true, false} {
		f, admin, pool, _ := auditFixture(t)
		err := audit.WithTransactionEvents(correlation.New(f.ctx), pool, func(ctx context.Context, q audit.Queries) ([]audit.Event, error) {
			first, err := insertBusiness(ctx, q)
			second := first
			second.ResourceID = secondFixtureID
			if !validSecond {
				second.ResourceID = "invalid"
			}
			return []audit.Event{first, second}, err
		})
		if validSecond {
			if err != nil {
				t.Fatal(err)
			}
			assertCounts(t, f, admin, 1, 2)
		} else {
			if err == nil {
				t.Fatal("invalid second event committed a partial operation")
			}
			assertCounts(t, f, admin, 0, 0)
		}
	}
}

func TestAuditFailuresRollbackBusinessWrites(t *testing.T) {
	for _, scenario := range []string{"permission", "callback", "invalid event", "cancel", "panic", "missing correlation"} {
		t.Run(scenario, func(t *testing.T) {
			f, admin, pool, role := auditFixture(t)
			ctx := correlation.New(f.ctx)
			if scenario == "permission" {
				if _, err := admin.Exec(f.ctx, "REVOKE INSERT "+auditColumns+" ON app.audit_events FROM "+role); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "missing correlation" {
				ctx = f.ctx
			}
			bounded, cancel := context.WithCancel(ctx)
			defer cancel()
			var result error
			panicked := false
			func() {
				defer func() {
					if recover() != nil {
						panicked = true
					}
				}()
				result = audit.WithTransaction(bounded, pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
					e, err := insertBusiness(ctx, q)
					if err != nil {
						return e, err
					}
					switch scenario {
					case "callback":
						return e, errors.New("synthetic mutation failure")
					case "invalid event":
						return audit.Event{}, nil
					case "cancel":
						cancel()
					case "panic":
						panic("synthetic panic")
					}
					return e, nil
				})
			}()
			if scenario == "panic" {
				if !panicked {
					t.Fatal("panic was swallowed")
				}
			} else if result == nil {
				t.Fatal("failed audit mutation committed")
			}
			if scenario == "permission" {
				var pgError *pgconn.PgError
				if !errors.As(result, &pgError) || pgError.Code != "42501" {
					t.Fatal("audit failure cause was not preserved")
				}
			}
			assertCounts(t, f, admin, 0, 0)
			if err := pool.Ping(f.ctx); err != nil {
				t.Fatal("failed mutation did not release usable pool resources")
			}
		})
	}
}

func TestAuditStorageDeniesHistoryAccessAndDefendsBroadenedGrants(t *testing.T) {
	f, admin, pool, role := auditFixture(t)
	if err := audit.WithTransaction(correlation.New(f.ctx), pool, insertBusiness); err != nil {
		t.Fatal(err)
	}
	denied := []string{
		"SELECT * FROM app.audit_events", "UPDATE app.audit_events SET event_name='fixture.deleted'", "DELETE FROM app.audit_events", "TRUNCATE app.audit_events",
		"ALTER TABLE app.audit_events DISABLE TRIGGER audit_history_append_only", "DROP TABLE app.audit_events",
		"INSERT INTO app.audit_events (id) VALUES ('" + fixtureID + "')",
		"INSERT INTO app.audit_events (occurred_at) VALUES (now())",
		"SET session_replication_role = replica",
	}
	for _, sql := range denied {
		if _, err := pool.Exec(f.ctx, sql); err == nil {
			t.Fatalf("runtime permitted %s", sql)
		}
	}
	if _, err := admin.Exec(f.ctx, "GRANT UPDATE, DELETE, TRUNCATE ON app.audit_events TO "+role); err != nil {
		t.Fatal(err)
	}
	for _, sql := range denied[1:4] {
		_, err := pool.Exec(f.ctx, sql)
		var pgError *pgconn.PgError
		if !errors.As(err, &pgError) || pgError.Code != "42501" || pgError.Message != "Audit history is append-only" {
			t.Fatal("defensive append trigger failed")
		}
	}
	assertCounts(t, f, admin, 1, 1)
	p := provider(t, f)
	if _, err := p.Down(f.ctx); err != nil {
		t.Fatal("empty administration migration did not roll back before audit check")
	}
	if _, err := p.Down(f.ctx); err != nil {
		t.Fatal("empty authorization migration did not roll back before audit check")
	}
	if _, err := p.Down(f.ctx); err != nil {
		t.Fatal("empty identity migration did not roll back before audit check")
	}
	if _, err := p.Down(f.ctx); err == nil {
		t.Fatal("rollback destroyed audit history")
	}
	assertCounts(t, f, admin, 1, 1)
}

func TestAuditDatabasePayloadAllowlists(t *testing.T) {
	f, admin, pool, _ := auditFixture(t)
	ctx := correlation.New(f.ctx)
	for _, payload := range []string{`{"password":"secret"}`, `{"token":"secret"}`, `{"status":"secret"}`, `{"status":null}`, `{"status":1}`, `{"exists":"secret"}`, `{"revision":-1}`, `{"revision":1.5}`, `{"revision":9223372036854775808}`, `{"revision":null}`, `[]`, `"secret"`, `{"free_text":"` + strings.Repeat("x", 1100) + `"}`} {
		_, err := pool.Exec(ctx, `INSERT INTO app.audit_events `+auditColumns+` VALUES ('system', NULL, 'fixture.created', 'fixture', $1::uuid, NULL, $2, $3::jsonb, 'null', '{"source":"cli"}')`, fixtureID, correlation.ID(ctx), payload)
		if err == nil {
			t.Fatal("database accepted unapproved snapshot")
		}
	}
	for _, metadata := range []string{`{"source":"cli","password":"secret"}`, `{"source":"unknown"}`, `{"source":null}`, `{"source":true}`, `{"source":1}`, `{}`, `null`, `{"source":"` + strings.Repeat("x", 300) + `"}`} {
		_, err := pool.Exec(ctx, `INSERT INTO app.audit_events `+auditColumns+` VALUES ('system', NULL, 'fixture.created', 'fixture', $1::uuid, NULL, $2, 'null', 'null', $3::jsonb)`, fixtureID, correlation.ID(ctx), metadata)
		if err == nil {
			t.Fatal("database accepted unapproved metadata")
		}
	}
	assertCounts(t, f, admin, 0, 0)
	// User/client references preserve UUIDs without inventing identity/domain FKs.
	err := audit.WithTransaction(ctx, pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		e, err := insertBusiness(ctx, q)
		e.Actor = audit.Actor{Kind: audit.User, UserID: fixtureID}
		e.ClientID = fixtureID
		return e, err
	})
	if err != nil {
		t.Fatal(err)
	}
	var matched bool
	if err := admin.QueryRow(f.ctx, "SELECT actor_user_id = $1::uuid AND client_id = $1::uuid FROM app.audit_events", fixtureID).Scan(&matched); err != nil || !matched {
		t.Fatal("typed actor/client references lost")
	}
}
