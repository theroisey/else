//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/theroisey/else/backend/internal/billing"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/database"
	"github.com/theroisey/else/backend/internal/integrations/catalog"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
	"github.com/theroisey/else/backend/internal/integrations/keysource"
	"github.com/theroisey/else/backend/internal/integrations/vault"
	"github.com/theroisey/else/backend/internal/planning"
	"github.com/theroisey/else/backend/internal/pricing"
	"github.com/theroisey/else/backend/internal/reminders"
	"github.com/theroisey/else/backend/internal/tasks"
)

const recoveryPriorRevision = "12b84cdfb598faf89b6c585ec62bf922a7fef5d5"

// This is an actual logical archive/restore, not a mocked database rewind.
// It requires the runner's owned disposable server and matching client tools.
func TestLogicalRecoveryAndCompatibleAPIRollback(t *testing.T) {
	currentBinary := buildCompiledAPI(t)
	priorBinary := buildRecoveryPriorAPI(t)
	for _, selected := range []bool{false, true} {
		name := "Meta_only_compatible_prior"
		if selected {
			name = "mixed_providers_prior_refused"
		}
		t.Run(name, func(t *testing.T) { rehearseLogicalRecovery(t, currentBinary, priorBinary, selected) })
	}
}

func rehearseLogicalRecovery(t *testing.T, currentBinary, priorBinary string, selected bool) {
	container := os.Getenv("TEST_POSTGRES_CONTAINER")
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(container) {
		t.Fatal("logical recovery requires test-integration.sh's disposable PostgreSQL container")
	}
	f := administrationFixtureFromIdentity(t, identityFixtureFromBase(t, newFixtureWithTimeout(t, 2*time.Minute)))
	api := startCompiledAPI(t, f, currentBinary) // Actual checked-in runtime grants.
	seedRecoveryFacts(t, f)
	if selected {
		service, err := vault.NewService(f.runtime, syntheticRing(t, "synthetic-primary", 0x6b))
		if err != nil {
			t.Fatal("selected recovery vault unavailable")
		}
		for index, provider := range []string{"ga4", "woocommerce"} {
			id := connectionID(index + 2)
			account := "123456789"
			if provider == "woocommerce" {
				account = "https://shop.example.com/store"
			}
			if _, err := f.admin.Exec(f.base.ctx, `INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES($1,$2,$3,$4)`, id, clientAID, provider, account); err != nil {
				t.Fatal("selected recovery connection seed failed")
			}
			ctx := correlation.New(f.base.ctx)
			checkpoint, err := service.Inspect(ctx, f.actor, clientAID, id)
			if err != nil {
				t.Fatal("selected recovery checkpoint failed")
			}
			if _, err := service.Replace(ctx, f.actor, clientAID, id, checkpoint, []byte("synthetic-recovery-credential")); err != nil {
				t.Fatal("selected recovery credential seed failed")
			}
		}
	}
	api.Close() // Snapshot after stopping the API, with no background writers.
	if _, err := f.admin.Exec(f.base.ctx, "SET TimeZone='UTC'"); err != nil {
		t.Fatal("source UTC session unavailable")
	}
	before := recoveryFingerprints(t, f.base.ctx, f.admin)
	archive, err := os.CreateTemp(t.TempDir(), "private-recovery-*.dump")
	if err != nil {
		t.Fatal("private archive creation failed")
	}
	defer archive.Close()
	if err := archive.Chmod(0600); err != nil {
		t.Fatal("private archive permissions failed")
	}
	dump := exec.CommandContext(f.base.ctx, "docker", "exec", container, "pg_dump", "--no-password", "--username=postgres", "--format=custom", "--dbname="+f.base.name)
	dump.Stdout = archive
	if dump.Run() != nil || archive.Sync() != nil {
		t.Fatal("disposable logical backup failed")
	}
	info, err := archive.Stat()
	if err != nil || info.Size() == 0 || info.Mode().Perm() != 0600 {
		t.Fatal("private logical archive is missing or unsafe")
	}
	// A later source write must not silently appear in the recovered checkpoint.
	if _, err := f.admin.Exec(f.base.ctx, "UPDATE app.clients SET name='Synthetic post-checkpoint write',revision=revision+1 WHERE id=$1", clientAID); err != nil {
		t.Fatal("post-checkpoint source write failed")
	}
	if reflect.DeepEqual(before, recoveryFingerprints(t, f.base.ctx, f.admin)) {
		t.Fatal("recovery checkpoint test did not change the source")
	}
	failed := newFixtureWithTimeout(t, 2*time.Minute)
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		t.Fatal("private truncated archive rewind failed")
	}
	broken := exec.CommandContext(failed.ctx, "docker", "exec", "-i", container, "pg_restore", "--no-password", "--username=postgres", "--exit-on-error", "--single-transaction", "--dbname="+failed.name)
	broken.Stdin = io.LimitReader(archive, info.Size()/2)
	if broken.Run() == nil {
		t.Fatal("truncated logical archive reported restore success")
	}
	failedAdmin := connection(t, failed)
	var partial bool
	if failedAdmin.QueryRow(failed.ctx, "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='app') OR to_regclass('public.goose_db_version') IS NOT NULL").Scan(&partial) != nil || partial {
		t.Fatal("truncated logical restore left application objects")
	}
	target := newFixtureWithTimeout(t, 2*time.Minute)
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		t.Fatal("private archive rewind failed")
	}
	restore := exec.CommandContext(target.ctx, "docker", "exec", "-i", container, "pg_restore", "--no-password", "--username=postgres", "--exit-on-error", "--single-transaction", "--dbname="+target.name)
	restore.Stdin = archive
	if restore.Run() != nil {
		t.Fatal("disposable logical restore failed")
	}
	admin := connection(t, target)
	if _, err := admin.Exec(target.ctx, "SET TimeZone='UTC'"); err != nil {
		t.Fatal("recovered UTC session unavailable")
	}
	if !reflect.DeepEqual(before, recoveryFingerprints(t, target.ctx, admin)) {
		t.Fatal("logical restore changed application rows or migration history")
	}
	// Roles are cluster-global and deliberately not dumped. This rehearsal uses
	// matching existing identities; a fresh cluster requires separate provisioning.
	u, _ := url.Parse(target.URL)
	cfg := f.runtime.Config().ConnConfig
	u.User = url.UserPassword(cfg.User, cfg.Password)
	pool, err := database.Open(target.ctx, settings(t, u.String()))
	if err != nil {
		t.Fatal("recovered least-privilege runtime failed")
	}
	defer pool.Close()
	for _, sql := range []string{"SELECT envelope FROM app.integration_credentials", "DELETE FROM app.audit_events", "UPDATE public.goose_db_version SET is_applied=false", "CREATE TABLE app.recovery_forbidden(id int)"} {
		if _, err := pool.Exec(target.ctx, sql); err == nil {
			t.Fatal("restored runtime acquired private or destructive privileges")
		}
	}
	var public bool
	if admin.QueryRow(target.ctx, "SELECT EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname='app' AND a.grantee=0)").Scan(&public) != nil || public {
		t.Fatal("restored private schema grants changed")
	}
	ring := syntheticRing(t, "synthetic-primary", 0x6b)
	if keysource.Preflight(target.ctx, pool, ring, true) != keysource.ErrUnavailable ||
		keysource.Preflight(target.ctx, pool, syntheticRing(t, "synthetic-fresh", 0x73), true) != keysource.ErrUnavailable ||
		keysource.Preflight(target.ctx, pool, retainedRing(t, "synthetic-fresh", 0x6b), true) != nil {
		t.Fatal("actual restored database violated fresh/retained key policy")
	}
	var raw []byte
	if admin.QueryRow(target.ctx, "SELECT envelope FROM app.integration_credentials WHERE connection_id=$1", connectionID(1)).Scan(&raw) != nil {
		t.Fatal("restored envelope missing")
	}
	envelope, err := credentials.ParseEnvelope(raw)
	clear(raw)
	if err != nil {
		t.Fatal("restored envelope framing failed")
	}
	secret, err := ring.Open(budgetBinding(clientAID, connectionID(1)), envelope)
	if err != nil || !bytes.Equal(secret, []byte("synthetic-recovery-credential")) {
		clear(secret)
		t.Fatal("retained key failed to authenticate restored ciphertext")
	}
	clear(secret)
	if selected {
		for index, provider := range []string{"ga4", "woocommerce"} {
			id := connectionID(index + 2)
			if admin.QueryRow(target.ctx, "SELECT envelope FROM app.integration_credentials WHERE connection_id=$1", id).Scan(&raw) != nil {
				t.Fatal("selected restored envelope missing")
			}
			envelope, err := credentials.ParseEnvelope(raw)
			clear(raw)
			if err != nil {
				t.Fatal("selected restored envelope invalid")
			}
			purpose, _ := catalog.CredentialPurpose(provider)
			secret, err := ring.Open(credentials.Binding{ClientID: clientAID, ConnectionID: id, Provider: provider, Purpose: purpose}, envelope)
			if err != nil || !bytes.Equal(secret, []byte("synthetic-recovery-credential")) {
				clear(secret)
				t.Fatal("selected restored ciphertext did not authenticate")
			}
			clear(secret)
		}
	}
	if !reflect.DeepEqual(before, recoveryFingerprints(t, target.ctx, admin)) {
		t.Fatal("restore key and privilege checks changed data")
	}
	recovered := &administrationFixture{identityFixture: &identityFixture{base: target, admin: admin, runtime: pool, runtimeRole: f.runtimeRole}, actor: f.actor, login: f.login}
	for index, binary := range []string{currentBinary, priorBinary, currentBinary} {
		a := startCompiledAPI(t, recovered, binary)
		for _, path := range []string{"clients/" + clientAID, "clients/" + clientAID + "/tasks", "clients/" + clientAID + "/reminders", "clients/" + clientAID + "/billing", "clients/" + clientAID + "/pricing", "clients/" + clientAID + "/integrations"} {
			if selected && strings.HasSuffix(path, "/integrations") {
				if index == 1 {
					recoveryPriorSelectedDenial(t, a, recovered)
				} else {
					recoveryRequest(t, a, recovered, "GET", path, "", "meta_ads", "ga4", "woocommerce")
				}
			} else {
				recoveryRequest(t, a, recovered, "GET", path, "")
			}
		}
		if index == 0 && !reflect.DeepEqual(before, recoveryFingerprints(t, target.ctx, admin)) {
			t.Fatal("restored current API reads changed data")
		}
		recoveryRequest(t, a, recovered, "PUT", "clients/"+clientAID, fmt.Sprintf(`{"name":"Synthetic recovery %d","expected_revision":%d}`, index, index+1))
		a.Close()
		for _, private := range []string{f.login.Token, f.login.CSRF, cfg.Password, "synthetic-recovery-credential", "Synthetic recovery", bootstrapPassword} {
			if strings.Contains(a.Logs.String(), private) {
				t.Fatal("recovery API log exposed private data")
			}
		}
		var revision, audits int
		if admin.QueryRow(target.ctx, "SELECT revision FROM app.clients WHERE id=$1", clientAID).Scan(&revision) != nil || revision != index+2 ||
			admin.QueryRow(target.ctx, "SELECT count(*) FROM app.audit_events WHERE resource_id=$1 AND event_name='client.updated'", clientAID).Scan(&audits) != nil || audits != index+1 {
			t.Fatal("current/prior/current recovery lost revision or atomic audit")
		}
	}
	t.Logf("logical recovery matched %d table/history fingerprints; retained-key and runtime privilege checks passed; three audited revisions passed (mixed providers: %t, prior provider compatibility only for Meta)", len(before), selected)
}

func buildRecoveryPriorAPI(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	archive := filepath.Join(directory, "prior-source.tar")
	command := exec.CommandContext(ctx, "git", "archive", "--format=tar", "--output="+archive, recoveryPriorRevision, "backend")
	command.Dir = "../../.."
	if command.Run() != nil || exec.CommandContext(ctx, "tar", "--extract", "--file="+archive, "--directory="+directory).Run() != nil {
		t.Fatal("pinned integrated API source unavailable; fetch reviewed history before rehearsal")
	}
	binary := filepath.Join(directory, "prior-api")
	command = exec.CommandContext(ctx, "sh", "scripts/build-api.sh", binary, "sha-"+recoveryPriorRevision, recoveryPriorRevision, "2026-10-04T00:00:00Z")
	command.Dir = filepath.Join(directory, "backend")
	command.Env = append(os.Environ(), "CGO_ENABLED=0")
	if command.Run() != nil {
		t.Fatal("pinned integrated API build failed")
	}
	return binary
}

func recoveryFingerprints(t *testing.T, ctx context.Context, conn *pgx.Conn) map[string]string {
	t.Helper()
	rows, err := conn.Query(ctx, "SELECT schemaname,tablename FROM pg_tables WHERE schemaname='app' OR (schemaname='public' AND tablename='goose_db_version') ORDER BY schemaname,tablename")
	if err != nil {
		t.Fatal("recovery table catalog unavailable")
	}
	var tables []pgx.Identifier
	for rows.Next() {
		var schema, table string
		if rows.Scan(&schema, &table) != nil {
			t.Fatal("recovery table catalog invalid")
		}
		tables = append(tables, pgx.Identifier{schema, table})
	}
	rows.Close()
	if rows.Err() != nil || len(tables) < 20 {
		t.Fatal("recovery table catalog incomplete")
	}
	result := make(map[string]string, len(tables))
	for _, table := range tables {
		var digest string
		if conn.QueryRow(ctx, "SELECT md5(coalesce(string_agg(to_jsonb(r)::text,',' ORDER BY to_jsonb(r)::text),'')) FROM "+table.Sanitize()+" r").Scan(&digest) != nil {
			t.Fatal("private recovery fingerprint failed")
		}
		result[table.Sanitize()] = digest // Compare privately; never print rows/digests.
	}
	var sequences string
	if conn.QueryRow(ctx, "SELECT md5(coalesce(string_agg(to_jsonb(s)::text,',' ORDER BY schemaname,sequencename),'')) FROM pg_sequences s WHERE schemaname='app' OR (schemaname='public' AND sequencename LIKE 'goose_db_version%')").Scan(&sequences) != nil {
		t.Fatal("private recovery sequence fingerprint failed")
	}
	result["sequences"] = sequences
	return result
}

func recoveryRequest(t *testing.T, api *compiledAPI, f *administrationFixture, method, path, body string, providers ...string) {
	t.Helper()
	r, err := http.NewRequestWithContext(api.Context, method, api.Origin+"/api/v1/"+path, strings.NewReader(body))
	if err != nil {
		t.Fatal("private recovery request invalid")
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", api.Origin)
	r.Header.Set("X-CSRF-Token", f.login.CSRF)
	r.AddCookie(&http.Cookie{Name: "else_session", Value: f.login.Token})
	r.AddCookie(&http.Cookie{Name: "else_csrf", Value: f.login.CSRF})
	response, err := api.Client.Do(r)
	if err != nil {
		t.Fatal("real recovery API response unavailable")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(data) > 65536 || response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("X-Request-ID") == "" {
		t.Fatalf("real recovery API contract failed: status=%d method=%s route=%s", response.StatusCode, method, path)
	}
	var value struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &value) != nil || len(value.Data) == 0 {
		t.Fatal("real recovery API data missing")
	}
	if method == "GET" && path != "clients/"+clientAID {
		var entries []json.RawMessage
		expected := 1
		if len(providers) > 0 {
			expected = len(providers)
		}
		if json.Unmarshal(value.Data, &entries) != nil || len(entries) != expected {
			t.Fatal("real recovery API lost seeded domain rows")
		}
		seen := map[string]bool{}
		for _, raw := range entries {
			var entry struct {
				ID       string
				ClientID string `json:"client_id"`
				Provider string
			}
			if json.Unmarshal(raw, &entry) != nil || entry.ID == "" || entry.ClientID != clientAID {
				t.Fatal("real recovery API lost client-bound domain data")
			}
			if len(providers) > 0 {
				allowed := false
				for _, provider := range providers {
					if provider == entry.Provider {
						allowed = true
					}
				}
				if !allowed || seen[entry.Provider] {
					t.Fatal("mixed recovery metadata provider lost or duplicated")
				}
				seen[entry.Provider] = true
			}
		}
	} else {
		var entry struct{ ID string }
		if json.Unmarshal(value.Data, &entry) != nil || entry.ID != clientAID {
			t.Fatal("real recovery API client identity differs")
		}
	}
}

// The pinned integrated artifact predates the selected catalog. A bounded safe
// error proves incompatibility; never approve it as a mixed-provider rollback.
func recoveryPriorSelectedDenial(t *testing.T, api *compiledAPI, f *administrationFixture) {
	t.Helper()
	request, err := http.NewRequestWithContext(api.Context, "GET", api.Origin+"/api/v1/clients/"+clientAID+"/integrations", nil)
	if err != nil {
		t.Fatal("prior compatibility probe invalid")
	}
	request.AddCookie(&http.Cookie{Name: "else_session", Value: f.login.Token})
	response, err := api.Client.Do(request)
	if err != nil {
		t.Fatal("prior compatibility probe unavailable")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 || response.StatusCode != http.StatusBadRequest || response.Header.Get("Cache-Control") != "no-store" || !bytes.Contains(raw, []byte(`"code":"invalid_request"`)) {
		t.Fatal("prior mixed-provider incompatibility was not safely observed")
	}
	for _, private := range []string{"shop.example.com", "123456789", "synthetic-recovery-credential", "provider_account_id", "envelope"} {
		if bytes.Contains(raw, []byte(private)) {
			t.Fatal("prior incompatibility exposed private data")
		}
	}
}

func seedRecoveryFacts(t *testing.T, f *administrationFixture) {
	t.Helper()
	ctx := correlation.New(f.base.ctx)
	taskService, err := tasks.NewService(f.runtime)
	if err != nil {
		t.Fatal("recovery task service failed")
	}
	if _, err := taskService.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()}); err != nil {
		t.Fatal("recovery task seed failed")
	}
	planService, err := planning.NewService(f.runtime)
	if err != nil {
		t.Fatal("recovery plan service failed")
	}
	if _, err := planService.Create(ctx, f.actor, clientAID, "", planningProfile()); err != nil {
		t.Fatal("recovery plan seed failed")
	}
	reminderService, err := reminders.NewService(f.runtime)
	if err != nil {
		t.Fatal("recovery reminder service failed")
	}
	if _, err := reminderService.Create(ctx, f.actor, clientAID, reminderProfile()); err != nil {
		t.Fatal("recovery reminder seed failed")
	}
	pricingService, err := pricing.NewService(f.runtime)
	if err != nil {
		t.Fatal("recovery pricing service failed")
	}
	p, err := pricingService.Create(ctx, f.actor, clientAID, pricingProfile())
	if err != nil {
		t.Fatal("recovery pricing seed failed")
	}
	collection, err := pricingService.Copy(ctx, f.actor, clientAID, p.ID, p.VersionID, p.Revision, pricingCopy(1))
	if err != nil {
		t.Fatal("recovery pricing copy seed failed")
	}
	billingService, err := billing.NewService(f.runtime)
	if err != nil {
		t.Fatal("recovery billing service failed")
	}
	if _, err := billingService.RecordPayment(ctx, f.actor, clientAID, collection.ID, collection.Revision, billingPayment(1, "25")); err != nil {
		t.Fatal("recovery payment seed failed")
	}
	if _, err := f.admin.Exec(ctx, "INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES($1,$2,'meta_ads','123456')", connectionID(1), clientAID); err != nil {
		t.Fatal("synthetic recovery binding seed failed")
	}
	service, err := vault.NewService(f.runtime, syntheticRing(t, "synthetic-primary", 0x6b))
	if err != nil {
		t.Fatal("recovery vault service failed")
	}
	checkpoint, err := service.Inspect(ctx, f.actor, clientAID, connectionID(1))
	if err != nil {
		t.Fatal("recovery vault checkpoint failed")
	}
	if _, err := service.Replace(ctx, f.actor, clientAID, connectionID(1), checkpoint, []byte("synthetic-recovery-credential")); err != nil {
		t.Fatal("recovery encrypted seed failed")
	}
}
