//go:build integration

package integration

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/theroisey/else/backend/internal/analytics"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/integrations/connections"
	"github.com/theroisey/else/backend/internal/integrations/providers/ga4"
)

const analyticsFunctions = `app.ga4_connection_create(uuid,uuid,uuid,text),app.analytics_writer_lock(),
app.analytics_sync_enqueue(uuid,uuid,uuid,bigint,bigint,bigint,date,date,uuid,boolean),
app.analytics_sync_cancel(uuid,uuid,uuid),app.analytics_job_allowed(uuid,uuid),app.analytics_sync_claim(),
app.analytics_sync_finish(uuid,uuid,jsonb),app.analytics_workspace_read(uuid,uuid,uuid,date,date),app.analytics_snapshots_prune(integer),app.analytics_connection_list(uuid,uuid,uuid,integer)`

type analyticsFixture struct {
	*vaultFixture
	analytics *analytics.Service
}

func newAnalyticsFixture(t *testing.T) *analyticsFixture {
	t.Helper()
	f := newDisconnectFixture(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+analyticsFunctions+` TO `+f.runtimeRole); err != nil {
		t.Fatal("analytics runtime entrypoints unavailable")
	}
	service, err := analytics.NewService(f.runtime, f.ring)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(f.logs, nil))
	auth, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	h, err := analytics.NewHandler(service, auth, logger)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := connections.NewHandler(f.connections, auth, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = httpapi.RequestMiddleware(logger, h.WithMetadata(metadata))
	return &analyticsFixture{f, service}
}

func analyticsKey(t *testing.T) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(der)
	raw, _ := json.Marshal(map[string]string{"type": "service_account", "private_key_id": "synthetic-key", "client_email": "synthetic@sample-project.iam.gserviceaccount.com", "private_key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "token_uri": "https://oauth2.googleapis.com/token"})
	return raw
}

func (f *analyticsFixture) create(t *testing.T, account string) connections.Connection {
	t.Helper()
	connection, err := f.analytics.Create(correlation.New(f.base.ctx), f.actor, clientAID, account)
	if err != nil {
		t.Fatal("pending analytics metadata create failed", err)
	}
	return connection
}

func (f *analyticsFixture) setup(t *testing.T, connection connections.Connection, key []byte) analytics.Queued {
	t.Helper()
	queued, err := f.analytics.Setup(correlation.New(f.base.ctx), f.actor, clientAID, connection.ID, connection.Revision, "2026-10-01", "2026-10-03", key)
	if err != nil || queued.State != "queued" || queued.ConnectionRevision != "3" {
		t.Fatal("encrypted queued setup failed", err)
	}
	return queued
}

type analyticsClaim struct {
	id, client, connection, state string
	lease                         *string
	before, revision              int64
}

func (f *analyticsFixture) claim(t *testing.T) analyticsClaim {
	t.Helper()
	var result analyticsClaim
	err := audit.WithTransaction(correlation.New(f.base.ctx), f.runtime, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		if err := q.QueryRow(ctx, `SELECT job_id::text,client_id::text,connection_id::text,state,before_revision,revision,lease_token::text FROM app.analytics_sync_claim()`).Scan(&result.id, &result.client, &result.connection, &result.state, &result.before, &result.revision, &result.lease); err != nil {
			return audit.Event{}, err
		}
		yes := true
		return audit.Event{Actor: audit.Actor{Kind: audit.System}, Action: audit.Updated, ResourceKind: "analytics_sync", ResourceID: result.id, ClientID: result.client,
			Before: &audit.Snapshot{Exists: &yes, Revision: &result.before}, After: &audit.Snapshot{Exists: &yes, Revision: &result.revision}, Metadata: audit.Metadata{Source: audit.Job}}, nil
	})
	if err != nil {
		t.Fatal("durable analytics claim failed", err)
	}
	return result
}

func syntheticAnalyticsWorkspace(client, connection string) ga4.Workspace {
	names := []string{"activeUsers", "sessions", "screenPageViews", "keyEvents"}
	w := ga4.Workspace{}
	for _, name := range names {
		kind := "TYPE_INTEGER"
		if name == "keyEvents" {
			kind = "TYPE_FLOAT"
		}
		w.Definitions = append(w.Definitions, ga4.Definition{Name: name, Type: kind, DisplayName: "Synthetic " + name, Description: "Synthetic contract definition"})
	}
	for _, template := range []struct {
		target             *ga4.Report
		dimensions, values []string
	}{
		{&w.Summary, []string{}, []string{}}, {&w.Daily, []string{"date"}, []string{"20261001"}},
		{&w.Acquisition, []string{"date", "sessionDefaultChannelGroup"}, []string{"20261001", "Organic Search"}},
		{&w.Devices, []string{"date", "deviceCategory"}, []string{"20261001", "desktop"}},
		{&w.Landing, []string{"landingPage"}, []string{"/synthetic"}},
	} {
		*template.target = ga4.Report{ClientID: client, ConnectionID: connection, APIVersion: "v1beta", Timezone: "Europe/Istanbul", Since: "2026-10-01", Until: "2026-10-03", Dimensions: template.dimensions, Metrics: append([]string(nil), names...), Rows: []ga4.Row{{Dimensions: template.values, Metrics: []string{"9007199254740993", "27", "81", "1.3333333333333333"}}}}
	}
	return w
}

func (f *analyticsFixture) finish(t *testing.T, claim analyticsClaim, workspace *ga4.Workspace) error {
	t.Helper()
	var raw []byte
	if workspace != nil {
		raw, _ = json.Marshal(workspace)
	}
	defer clear(raw)
	err := audit.WithTransactionEvents(correlation.New(f.base.ctx), f.runtime, func(ctx context.Context, q audit.Queries) ([]audit.Event, error) {
		var id, client, connection, state string
		var snapshot *string
		var bj, aj, bc, ac, bs, as int64
		if err := q.QueryRow(ctx, `SELECT job_id::text,client_id::text,connection_id::text,state,before_job_revision,job_revision,before_connection_revision,connection_revision,snapshot_id::text,before_snapshot_revision,snapshot_revision FROM app.analytics_sync_finish($1::uuid,$2::uuid,$3::jsonb)`, claim.id, *claim.lease, raw).Scan(&id, &client, &connection, &state, &bj, &aj, &bc, &ac, &snapshot, &bs, &as); err != nil {
			return nil, err
		}
		yes, no := true, false
		events := []audit.Event{{Actor: audit.Actor{Kind: audit.System}, Action: audit.Updated, ResourceKind: "analytics_sync", ResourceID: id, ClientID: client, Before: &audit.Snapshot{Exists: &yes, Revision: &bj}, After: &audit.Snapshot{Exists: &yes, Revision: &aj}, Metadata: audit.Metadata{Source: audit.Job}}}
		if snapshot != nil {
			action := audit.Created
			exists := no
			var prior *int64
			if bs > 0 {
				action = audit.Updated
				exists = yes
				prior = &bs
			}
			events = append(events, audit.Event{Actor: audit.Actor{Kind: audit.System}, Action: action, ResourceKind: "analytics_snapshot", ResourceID: *snapshot, ClientID: client, Before: &audit.Snapshot{Exists: &exists, Revision: prior}, After: &audit.Snapshot{Exists: &yes, Revision: &as}, Metadata: audit.Metadata{Source: audit.Job}}, audit.Event{Actor: audit.Actor{Kind: audit.System}, Action: audit.Updated, ResourceKind: "integration_connection", ResourceID: connection, ClientID: client, Before: &audit.Snapshot{Exists: &yes, Revision: &bc}, After: &audit.Snapshot{Exists: &yes, Revision: &ac}, Metadata: audit.Metadata{Source: audit.Job}})
		}
		return events, nil
	})
	if err != nil {
		var sql *pgconn.PgError
		if errors.As(err, &sql) {
			// Fixed SQL error classification only; never print Detail, rows, inputs,
			// credentials or unwrapped provider diagnostics.
			t.Log("analytics publication SQL code", sql.Code)
		}
	}
	return err
}

func TestAnalyticsEncryptedSetupMeasuredReadAndDeterministicReplacement(t *testing.T) {
	f := newAnalyticsFixture(t)
	key := analyticsKey(t)
	defer clear(key)
	c := f.create(t, "123456789")
	queued := f.setup(t, c, key)
	if count, events := f.accounting(t); count != 1 || events != 1 {
		t.Fatal("setup lost irreversible accounting")
	}
	var state string
	var generation int64
	if f.admin.QueryRow(f.base.ctx, `SELECT state,generation FROM app.integration_connections WHERE id=$1`, c.ID).Scan(&state, &generation) != nil || state != "pending" || generation != 2 {
		t.Fatal("setup fabricated connected state")
	}
	if _, err := f.analytics.Enqueue(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, "3", "2026-10-01", "2026-10-03"); err != analytics.ErrConflict {
		t.Fatal("duplicate active job accepted")
	}
	claim := f.claim(t)
	if claim.id != queued.JobID || claim.state != "running" || claim.lease == nil {
		t.Fatal("wrong work claimed")
	}
	w := syntheticAnalyticsWorkspace(clientAID, c.ID)
	if !ga4.ValidWorkspace(w, ga4.Request{ClientID: clientAID, ConnectionID: c.ID, Since: w.Summary.Since, Until: w.Summary.Until}) {
		t.Fatal("synthetic normalized workspace invalid")
	}
	if err := f.finish(t, claim, &w); err != nil {
		t.Fatal("atomic snapshot publication failed", err)
	}
	view, err := f.analytics.Read(f.base.ctx, f.actor, clientAID, c.ID, "2026-10-01", "2026-10-03")
	if err != nil || view.Data == nil || view.Status.State != "succeeded" || view.Status.Stale || view.Status.SyncedAt == nil || !reflect.DeepEqual(*view.Data, w) {
		t.Fatal("measured report differs", err)
	}
	if _, err := f.analytics.Read(f.base.ctx, f.actor, clientBID, c.ID, "2026-10-01", "2026-10-03"); err != analytics.ErrMissing {
		t.Fatal("cross-client measured report exposed")
	}
	if _, err := f.analytics.Enqueue(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, "4", "2026-10-01", "2026-10-03"); err != nil {
		t.Fatal("explicit repeat unavailable", err)
	}
	claim = f.claim(t)
	if err := f.finish(t, claim, &w); err != nil {
		t.Fatal(err)
	}
	var snapshots, revision int
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*),max(revision) FROM app.analytics_snapshots WHERE connection_id=$1`, c.ID).Scan(&snapshots, &revision) != nil || snapshots != 1 || revision != 2 {
		t.Fatal("period refresh duplicated observations")
	}
	encoded, _ := json.Marshal(view)
	for _, private := range []string{"123456789", "private_key", "PRIVATE KEY", "lease_token", "generation", "requested_by"} {
		if strings.Contains(string(encoded), private) {
			t.Fatal("private provider/job context exposed")
		}
	}
}

func TestAnalyticsSetupHTTPAuthenticationCSRFIsolationAndSecretPrivacy(t *testing.T) {
	f := newAnalyticsFixture(t)
	key := analyticsKey(t)
	defer clear(key)
	path := metadataPath(clientAID) + "/ga4"
	body := map[string]string{"property_id": "123456789"}
	assertStatus(t, f.request(t, nil, "POST", path, body, nil), 401, "authentication_required")
	w := f.request(t, &f.login, "POST", path, body, nil)
	assertStatus(t, w, 201, "")
	var created struct {
		Data connections.Connection `json:"data"`
	}
	if json.Unmarshal(w.Body.Bytes(), &created) != nil || created.Data.State != "pending" {
		t.Fatal("pending HTTP create unavailable")
	}
	setupBody := map[string]string{"revision": "1", "since": "2026-10-01", "until": "2026-10-03", "credential_json": string(key)}
	setupPath := metadataPath(clientAID) + "/" + created.Data.ID + "/ga4/credentials"
	for _, guard := range []struct {
		alter  func(*http.Request)
		status int
	}{
		{func(r *http.Request) { r.Header.Del("X-CSRF-Token") }, 403},
		{func(r *http.Request) { r.Header.Set("Origin", "https://untrusted.example.com") }, 403},
		{func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		{func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(`{"revision":"1","revision":"1"}`)) }, 400},
		{func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(strings.Repeat(" ", 33<<10))) }, 400},
	} {
		response := f.request(t, &f.login, "POST", setupPath, setupBody, guard.alter)
		assertStatus(t, response, guard.status, "")
	}
	w = f.request(t, &f.login, "POST", setupPath, setupBody, nil)
	assertStatus(t, w, 202, "")
	assertStatus(t, f.request(t, &f.login, "POST", setupPath, setupBody, nil), 409, "conflict")
	readPath := metadataPath(clientAID) + "/" + created.Data.ID + "/ga4?since=2026-10-01&until=2026-10-03"
	w = f.request(t, &f.login, "GET", readPath, nil, nil)
	assertStatus(t, w, 200, "")
	if !strings.Contains(w.Body.String(), `"state":"queued"`) || !strings.Contains(w.Body.String(), `"data":null`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("queued status fabricated observations")
	}
	user, _ := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsView}, clientAID)
	if _, err := f.analytics.Read(f.base.ctx, user, clientAID, created.Data.ID, "2026-10-01", "2026-10-03"); err != analytics.ErrMissing {
		t.Fatal("integration view implied analytics view")
	}
	if _, err := f.analytics.Create(correlation.New(f.base.ctx), user, clientAID, "999"); err != analytics.ErrMissing {
		t.Fatal("view-only actor created connection")
	}
	for _, sql := range []string{`SELECT * FROM app.analytics_sync_jobs`, `SELECT workspace FROM app.analytics_snapshots`, `UPDATE app.analytics_sync_jobs SET state='failed'`, `DELETE FROM app.analytics_snapshots`} {
		if _, err := f.runtime.Exec(f.base.ctx, sql); err == nil {
			t.Fatal("runtime bypassed guarded analytics entrypoints")
		}
	}
	for _, private := range []string{string(key), "PRIVATE KEY", "123456789", "synthetic@sample-project"} {
		if strings.Contains(f.logs.String(), private) {
			t.Fatal("setup logged private input")
		}
	}
	var unsafe bool
	if f.admin.QueryRow(f.base.ctx, `SELECT EXISTS(SELECT 1 FROM app.audit_events WHERE before_state::text||after_state::text||metadata::text LIKE '%PRIVATE KEY%' OR before_state::text||after_state::text||metadata::text LIKE '%123456789%')`).Scan(&unsafe) != nil || unsafe {
		t.Fatal("setup audited private values")
	}
}

func TestAnalyticsReplicaAdmissionLeaseRecoveryAndStaleGeneration(t *testing.T) {
	f := newAnalyticsFixture(t)
	key := analyticsKey(t)
	defer clear(key)
	for i := 0; i < 3; i++ {
		c := f.create(t, fmt.Sprintf("12345678%d", i))
		f.setup(t, c, key)
	}
	var wg sync.WaitGroup
	results := make(chan bool, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := audit.WithTransaction(correlation.New(f.base.ctx), f.runtime, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
				var id, client string
				var before, after int64
				if err := q.QueryRow(ctx, `SELECT job_id::text,client_id::text,before_revision,revision FROM app.analytics_sync_claim()`).Scan(&id, &client, &before, &after); err != nil {
					return audit.Event{}, err
				}
				yes := true
				return audit.Event{Actor: audit.Actor{Kind: audit.System}, Action: audit.Updated, ResourceKind: "analytics_sync", ResourceID: id, ClientID: client, Before: &audit.Snapshot{Exists: &yes, Revision: &before}, After: &audit.Snapshot{Exists: &yes, Revision: &after}, Metadata: audit.Metadata{Source: audit.Job}}, nil
			})
			results <- err == nil
		}()
	}
	wg.Wait()
	close(results)
	count := 0
	for claimed := range results {
		if claimed {
			count++
		}
	}
	if count != 2 {
		t.Fatal("replica admission did not cap leases at two")
	}
	var old analyticsClaim
	if f.admin.QueryRow(f.base.ctx, `SELECT id::text,client_id::text,connection_id::text,lease_token::text FROM app.analytics_sync_jobs WHERE state='running' ORDER BY created_at,id LIMIT 1`).Scan(&old.id, &old.client, &old.connection, &old.lease) != nil {
		t.Fatal("running lease missing")
	}
	if _, err := f.admin.Exec(f.base.ctx, `UPDATE app.analytics_sync_jobs SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1`, old.id); err != nil {
		t.Fatal(err)
	}
	reclaimed := f.claim(t)
	if reclaimed.id != old.id || reclaimed.lease == nil || *reclaimed.lease == *old.lease {
		t.Fatal("abandoned lease was not fenced/reclaimed")
	}
	w := syntheticAnalyticsWorkspace(old.client, old.connection)
	if err := f.finish(t, old, &w); err == nil {
		t.Fatal("expired claimant published")
	}
	if _, err := f.analytics.Setup(correlation.New(f.base.ctx), f.actor, old.client, old.connection, "3", "2026-10-01", "2026-10-03", key); err != nil {
		t.Fatal("replacement did not cancel older lease", err)
	}
	if err := f.finish(t, reclaimed, &w); err == nil {
		t.Fatal("replaced generation published")
	}
	var snapshots int
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.analytics_snapshots`).Scan(&snapshots) != nil || snapshots != 0 {
		t.Fatal("stale work wrote observations")
	}
}

func TestAnalyticsPermissionRevocationAndAuditFailureCannotPublish(t *testing.T) {
	f := newAnalyticsFixture(t)
	key := analyticsKey(t)
	defer clear(key)
	c := f.create(t, "123456789")
	user, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage, authorization.AnalyticsView}, clientAID)
	if _, err := f.analytics.Setup(correlation.New(f.base.ctx), user, clientAID, c.ID, "1", "2026-10-01", "2026-10-03", key); err != nil {
		t.Fatal(err)
	}
	claim := f.claim(t)
	if err := f.authorizer.RevokeRole(correlation.New(f.base.ctx), f.actor, assignment); err != nil {
		t.Fatal(err)
	}
	var allowed bool
	if f.runtime.QueryRow(f.base.ctx, `SELECT app.analytics_job_allowed($1::uuid,$2::uuid)`, claim.id, *claim.lease).Scan(&allowed) != nil || allowed {
		t.Fatal("revoked job fence remained allowed")
	}
	w := syntheticAnalyticsWorkspace(clientAID, c.ID)
	if err := f.finish(t, claim, &w); err != nil {
		t.Fatal("revocation failed outcome unavailable", err)
	}
	var state, reason string
	if f.admin.QueryRow(f.base.ctx, `SELECT state,reason FROM app.analytics_sync_jobs WHERE id=$1`, claim.id).Scan(&state, &reason) != nil || state != "failed" || reason != "authorization_required" {
		t.Fatal("revoked work claimed success")
	}
	if _, err := f.analytics.Enqueue(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, "3", "2026-10-01", "2026-10-03"); err != nil {
		t.Fatal(err)
	}
	claim = f.claim(t)
	if _, err := f.admin.Exec(f.base.ctx, `CREATE FUNCTION app.analytics_fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.resource_kind='analytics_snapshot' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER analytics_fixture_audit_failure BEFORE INSERT ON app.audit_events FOR EACH ROW EXECUTE FUNCTION app.analytics_fixture_audit_failure()`); err != nil {
		t.Fatal(err)
	}
	if err := f.finish(t, claim, &w); err == nil {
		t.Fatal("failed audit published successful workspace")
	}
	var snapshots int
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.analytics_snapshots`).Scan(&snapshots) != nil || snapshots != 0 {
		t.Fatal("audit failure stored partial metrics")
	}
	if _, err := provider(t, f.base).DownTo(f.base.ctx, 22); err == nil {
		t.Fatal("populated sync history was destroyed by rollback")
	}
}

func TestAnalyticsStrictWorkspaceRetentionAndSyntheticWorkerFailure(t *testing.T) {
	f := newAnalyticsFixture(t)
	key := analyticsKey(t)
	defer clear(key)
	c := f.create(t, "123456789")
	f.setup(t, c, key)
	claim := f.claim(t)
	w := syntheticAnalyticsWorkspace(clientAID, c.ID)
	raw, _ := json.Marshal(w)
	for _, bad := range [][]byte{[]byte(strings.Replace(string(raw), `"summary":`, `"private_token":"synthetic-secret","summary":`, 1)), []byte(strings.Replace(string(raw), clientAID, clientBID, 1)), []byte(strings.Replace(string(raw), "9007199254740993", "1.5", 1)), []byte(strings.Replace(string(raw), "/synthetic", "/synthetic?email=private@example.com", 1)), []byte(strings.ReplaceAll(string(raw), "Europe/Istanbul", "Invalid/Zone"))} {
		var valid bool
		if f.admin.QueryRow(f.base.ctx, `SELECT app.analytics_workspace_valid($1::jsonb,$2::uuid,$3::uuid,'2026-10-01','2026-10-03')`, bad, clientAID, c.ID).Scan(&valid) != nil || valid {
			t.Fatal("SQL workspace boundary accepted private/misbound values")
		}
	}
	if err := f.finish(t, claim, &w); err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(f.base.ctx, `UPDATE app.analytics_snapshots SET synced_at=clock_timestamp()-INTERVAL '91 days' WHERE connection_id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	view, err := f.analytics.Read(f.base.ctx, f.actor, clientAID, c.ID, "2026-10-01", "2026-10-03")
	if err != nil || view.Data != nil || !view.Status.Stale {
		t.Fatal("expired aggregate remains readable")
	}
	if err := f.analytics.Prune(f.base.ctx); err != nil {
		t.Fatal("audited aggregate retention failed", err)
	}
	var snapshots, audits int
	if f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.analytics_snapshots),(SELECT count(*) FROM app.audit_events WHERE resource_kind='analytics_snapshot' AND event_name='analytics_snapshot.deleted')`).Scan(&snapshots, &audits) != nil || snapshots != 0 || audits != 1 {
		t.Fatal("retention deleted wrong records or omitted audit")
	}
	// A deliberately malformed synthetic vault payload exercises the real worker
	// without making any live provider request. It must record failure, not zeros.
	checkpoint, err := f.vault.Inspect(correlation.New(f.base.ctx), f.actor, clientAID, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint, err = f.vault.Replace(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, checkpoint, []byte("synthetic-invalid-key"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.analytics.Enqueue(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, fmt.Sprint(checkpoint.ConnectionRevision), "2026-10-01", "2026-10-03"); err != nil {
		t.Fatal(err)
	}
	worker, err := analytics.NewWorker(f.analytics)
	if err != nil {
		t.Fatal(err)
	}
	if didWork, err := worker.RunOnce(f.base.ctx); err != nil || !didWork {
		t.Fatal("synthetic worker did not record safe failure", err)
	}
	view, err = f.analytics.Read(f.base.ctx, f.actor, clientAID, c.ID, "2026-10-01", "2026-10-03")
	if err != nil || view.Data != nil || view.Status.State != "failed" || view.Status.Reason == nil || *view.Status.Reason != "provider_unavailable" {
		t.Fatal("worker failure manufactured observations", err)
	}
	if didWork, err := worker.RunOnce(f.base.ctx); err != nil || didWork {
		t.Fatal("provider failure was automatically retried", err)
	}
}

func TestAnalyticsSetupAuditFailureBurnsBudgetWithoutCredentialOrJobCommit(t *testing.T) {
	f := newAnalyticsFixture(t)
	key := analyticsKey(t)
	defer clear(key)
	c := f.create(t, "123456789")
	if _, err := f.admin.Exec(f.base.ctx, `CREATE FUNCTION app.analytics_setup_fixture_fail() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.resource_kind='analytics_sync' THEN RAISE EXCEPTION 'Synthetic setup audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER analytics_setup_fixture_fail BEFORE INSERT ON app.audit_events FOR EACH ROW EXECUTE FUNCTION app.analytics_setup_fixture_fail()`); err != nil {
		t.Fatal(err)
	}
	if queued, err := f.analytics.Setup(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, "1", "2026-10-01", "2026-10-03", key); err != analytics.ErrUnavailable || queued != (analytics.Queued{}) {
		t.Fatal("failed setup audit claimed queued credentials", err)
	}
	checkpoint, err := f.vault.Inspect(correlation.New(f.base.ctx), f.actor, clientAID, c.ID)
	if err != nil || checkpoint.ConnectionRevision != 1 || checkpoint.Generation != 1 || checkpoint.CredentialRevision != 0 {
		t.Fatal("failed setup committed partial lifecycle state")
	}
	if count, events := f.accounting(t); count != 1 || events != 1 {
		t.Fatal("failed setup refunded irreversible reservation")
	}
	var jobs int
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.analytics_sync_jobs`).Scan(&jobs) != nil || jobs != 0 {
		t.Fatal("failed setup left orphaned job")
	}
}

func TestAnalyticsIndependentReportPermissionAndBoundedCrashRetries(t *testing.T) {
	f := newAnalyticsFixture(t)
	key := analyticsKey(t)
	defer clear(key)
	c := f.create(t, "123456789")
	f.setup(t, c, key)
	user, _ := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.AnalyticsView}, clientAID)
	page, err := f.analytics.List(f.base.ctx, user, clientAID, "")
	if err != nil || len(page.Data) != 1 || page.Data[0].ID != c.ID || page.NextID != nil {
		t.Fatal("analytics view unexpectedly required integration view", err)
	}
	if _, err := f.connections.Detail(f.base.ctx, user, clientAID, c.ID); err != connections.ErrMissing {
		t.Fatal("analytics view implied integration metadata access")
	}
	if _, err := f.analytics.List(f.base.ctx, user, clientBID, ""); err != analytics.ErrMissing {
		t.Fatal("report catalog crossed client scope")
	}
	claim := f.claim(t)
	for attempt := 1; attempt <= 3; attempt++ {
		if _, err := f.admin.Exec(f.base.ctx, `UPDATE app.analytics_sync_jobs SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1`, claim.id); err != nil {
			t.Fatal(err)
		}
		claim = f.claim(t)
		if (attempt < 3 && claim.state != "running") || (attempt == 3 && (claim.state != "failed" || claim.lease != nil)) {
			t.Fatal("abandoned job exceeded three attempts or kept lease")
		}
	}
	var attempts int
	var reason string
	if f.admin.QueryRow(f.base.ctx, `SELECT attempts,reason FROM app.analytics_sync_jobs WHERE id=$1`, claim.id).Scan(&attempts, &reason) != nil || attempts != 3 || reason != "interrupted" {
		t.Fatal("crash retry accounting changed")
	}
}
