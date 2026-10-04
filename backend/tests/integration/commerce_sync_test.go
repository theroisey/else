//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/theroisey/else/backend/internal/analytics"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/connections"
	"github.com/theroisey/else/backend/internal/integrations/providers/woocommerce"
)

const commerceFunctions = `app.commerce_connection_create(uuid,uuid,uuid,text),
app.commerce_sync_enqueue(uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,text,uuid,boolean),
app.commerce_sync_cancel(uuid,uuid,uuid),app.commerce_sync_finish(uuid,uuid,jsonb),
app.commerce_workspace_read(uuid,uuid,uuid,timestamptz,timestamptz,text),app.commerce_connection_list(uuid,uuid,uuid,integer)`
const commerceStart = "2026-10-01T00:00:00Z"
const commerceEnd = "2026-10-02T00:00:00Z"

func newCommerceFixture(t *testing.T) *analyticsFixture {
	t.Helper()
	f := newAnalyticsFixture(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+commerceFunctions+` TO `+f.runtimeRole); err != nil {
		t.Fatal("commerce entrypoints unavailable")
	}
	return f
}

func commerceKey() []byte {
	return []byte(`{"consumer_key":"ck_` + strings.Repeat("a", 40) + `","consumer_secret":"cs_` + strings.Repeat("b", 40) + `"}`)
}

func (f *analyticsFixture) createCommerce(t *testing.T, origin string) connections.Connection {
	t.Helper()
	c, err := f.analytics.CreateCommerce(correlation.New(f.base.ctx), f.actor, clientAID, origin)
	if err != nil || c.Provider != "woocommerce" || c.State != "pending" || c.Revision != "1" {
		t.Fatal("pending commerce create failed", err)
	}
	return c
}

func (f *analyticsFixture) setupCommerce(t *testing.T, c connections.Connection) analytics.Queued {
	t.Helper()
	key := commerceKey()
	defer clear(key)
	q, err := f.analytics.SetupCommerce(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, c.Revision, commerceStart, commerceEnd, "USD", key)
	if err != nil || q.ConnectionRevision != "3" || q.State != "queued" {
		t.Fatal("encrypted commerce setup failed", err)
	}
	return q
}

func (f *analyticsFixture) claimProvider(provider string) (analyticsClaim, error) {
	var result analyticsClaim
	err := audit.WithTransaction(correlation.New(f.base.ctx), f.runtime, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		if err := q.QueryRow(ctx, `SELECT job_id::text,client_id::text,connection_id::text,state,before_revision,revision,lease_token::text FROM app.provider_sync_claim($1)`, provider).Scan(&result.id, &result.client, &result.connection, &result.state, &result.before, &result.revision, &result.lease); err != nil {
			return audit.Event{}, err
		}
		yes := true
		return audit.Event{Actor: audit.Actor{Kind: audit.System}, Action: audit.Updated, ResourceKind: "analytics_sync", ResourceID: result.id, ClientID: result.client,
			Before: &audit.Snapshot{Exists: &yes, Revision: &result.before}, After: &audit.Snapshot{Exists: &yes, Revision: &result.revision}, Metadata: audit.Metadata{Source: audit.Job}}, nil
	})
	return result, err
}

// Deliberately synthetic provider projections exercise real normalization and
// durable publication without live shop credentials, network or ownership claims.
func syntheticCommerceWorkspace(t *testing.T, connection string) woocommerce.Workspace {
	t.Helper()
	e := woocommerce.Expectation{ClientID: clientAID, ConnectionID: connection, Start: commerceStart, End: commerceEnd, Currency: "USD", PerPage: 100}
	orders, products, err := woocommerce.NormalizeOrdersAndProducts(e, []woocommerce.Page{{Number: 1, Total: "1", TotalPages: "1", Body: []byte(`[{"id":1,"status":"pending","currency":"USD","date_created_gmt":"2026-10-01T00:00:00","total":"100.010000","refunds":[{"id":10,"total":"-1.010000"}],"line_items":[{"id":1001,"product_id":3,"variation_id":0,"quantity":9007199254740993,"total":"90.010000","total_tax":"10.000000"}]}]`)}})
	if err != nil {
		t.Fatal("synthetic product/order normalization failed")
	}
	refunds, err := woocommerce.NormalizeRefunds(e, []woocommerce.Page{{Number: 1, Total: "1", TotalPages: "1", Body: []byte(`[{"id":10,"parent_id":1,"date_created_gmt":"2026-10-01T12:00:00","amount":"1.010000"}]`)}}, []woocommerce.Parent{{ID: "1", Currency: "USD"}})
	if err != nil {
		t.Fatal("synthetic refund normalization failed")
	}
	stamp := time.Now().UTC().Truncate(time.Microsecond)
	w := woocommerce.Workspace{Orders: orders, Refunds: refunds, Products: products, CollectedFrom: stamp, CollectedThrough: stamp.Add(time.Microsecond)}
	if !woocommerce.ValidWorkspace(w, e) {
		t.Fatal("synthetic commerce workspace invalid")
	}
	return w
}

func TestCommerceEncryptedSetupExactStoredReadAndIdempotentFailedRefresh(t *testing.T) {
	f := newCommerceFixture(t)
	c := f.createCommerce(t, "https://shop.example.com")
	queued := f.setupCommerce(t, c)
	claim, err := f.claimProvider("woocommerce")
	if err != nil || claim.id != queued.JobID || claim.state != "running" || claim.lease == nil {
		t.Fatal("commerce claim unavailable", err)
	}
	w := syntheticCommerceWorkspace(t, c.ID)
	raw, _ := json.Marshal(w)
	defer clear(raw)
	if err := f.finishRaw(t, claim, "woocommerce", raw); err != nil {
		t.Fatal("complete publication failed", err)
	}
	reader, _ := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.AnalyticsView}, clientAID)
	view, err := f.analytics.ReadCommerce(f.base.ctx, reader, clientAID, c.ID, commerceStart, commerceEnd, "USD")
	if err != nil || view.Data == nil || view.Status.State != "succeeded" || view.Status.Stale || !reflect.DeepEqual(*view.Data, w) {
		t.Fatal("exact measured report differs", err)
	}
	if _, err := f.connections.Detail(f.base.ctx, reader, clientAID, c.ID); err != connections.ErrMissing {
		t.Fatal("commerce report grant implied integration view")
	}
	page, err := f.analytics.ListCommerce(f.base.ctx, reader, clientAID, "")
	if err != nil || len(page.Data) != 1 || page.Data[0].ID != c.ID {
		t.Fatal("independent commerce catalog failed", err)
	}
	if _, err := f.analytics.ReadCommerce(f.base.ctx, reader, clientBID, c.ID, commerceStart, commerceEnd, "USD"); err != analytics.ErrMissing {
		t.Fatal("cross-client report exposed")
	}
	other, err := f.analytics.ReadCommerce(f.base.ctx, reader, clientAID, c.ID, commerceStart, commerceEnd, "TRY")
	if err != nil || other.Data != nil || other.Status.State != "not_synced" {
		t.Fatal("currency was silently inferred")
	}
	for _, revision := range []string{"4", "5"} {
		if _, err := f.analytics.EnqueueCommerce(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, revision, commerceStart, commerceEnd, "USD"); err != nil {
			t.Fatal("explicit refresh failed", err)
		}
		claim, err = f.claimProvider("woocommerce")
		if err != nil {
			t.Fatal(err)
		}
		value := raw
		if revision == "5" {
			value = nil
		}
		if err := f.finishRaw(t, claim, "woocommerce", value); err != nil {
			t.Fatal(err)
		}
	}
	view, err = f.analytics.ReadCommerce(f.base.ctx, reader, clientAID, c.ID, commerceStart, commerceEnd, "USD")
	if err != nil || view.Data == nil || view.Status.State != "failed" || view.Status.Reason == nil || *view.Status.Reason != "provider_unavailable" || view.Status.SyncedAt == nil {
		t.Fatal("failed refresh erased complete prior report or hid failure", err)
	}
	var count, revision int
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*),max(revision) FROM app.analytics_snapshots WHERE connection_id=$1`, c.ID).Scan(&count, &revision) != nil || count != 1 || revision != 2 {
		t.Fatal("refresh duplicated report")
	}
	if units, events := f.accounting(t); units != 1 || events != 1 {
		t.Fatal("setup lost irreversible encryption accounting")
	}
	for _, private := range []string{"shop.example.com", "consumer_key", "consumer_secret", "lease_token", "generation", "requested_by", strings.Repeat("a", 40)} {
		encoded, _ := json.Marshal(view)
		if strings.Contains(string(encoded), private) || strings.Contains(f.logs.String(), private) {
			t.Fatal("private setup/job context leaked")
		}
	}
}

func TestCommerceSQLValidationRetentionAndRollbackProtection(t *testing.T) {
	f := newCommerceFixture(t)
	c := f.createCommerce(t, "https://shop.example.com")
	f.setupCommerce(t, c)
	claim, err := f.claimProvider("woocommerce")
	if err != nil {
		t.Fatal(err)
	}
	w := syntheticCommerceWorkspace(t, c.ID)
	raw, _ := json.Marshal(w)
	defer clear(raw)
	for _, mutation := range []string{
		strings.Replace(string(raw), `"orders":{`, `"orders":{"billing":{},`, 1),
		strings.Replace(string(raw), `"products":[{`, `"products":[{"name":"private",`, 1),
		strings.Replace(string(raw), `"refunds":[{`, `"refunds":[{"reason":"private",`, 1),
		strings.Replace(string(raw), clientAID, clientBID, 1),
		strings.Replace(string(raw), `"grand_total_minor":"10001"`, `"grand_total_minor":"10002"`, 1),
		strings.Replace(string(raw), `"quantity":"9007199254740993"`, `"quantity":"0"`, 1),
		strings.Replace(string(raw), `"created_at":"2026-10-01T00:00:00Z"`, `"created_at":"2026-10-02T00:00:00Z"`, 1),
		strings.Replace(string(raw), `"currency":"USD"`, `"currency":"TRY"`, 1),
		strings.Replace(string(raw), `"amount_minor":"101"`, `"amount_minor":"-101"`, 1),
	} {
		if mutation == string(raw) {
			t.Fatal("SQL mutation did not change fixture")
		}
		var valid bool
		if f.admin.QueryRow(f.base.ctx, `SELECT app.commerce_workspace_valid($1::jsonb,$2::uuid,$3::uuid,$4::timestamptz,$5::timestamptz,'USD')`, mutation, clientAID, c.ID, commerceStart, commerceEnd).Scan(&valid) != nil || valid {
			t.Fatal("SQL admitted private/inexact/misbound report")
		}
		if err := f.finishRaw(t, claim, "woocommerce", []byte(mutation)); err == nil {
			t.Fatal("invalid report published")
		}
	}
	if err := f.finishRaw(t, claim, "woocommerce", raw); err != nil {
		t.Fatal("valid report failed after rejected writes", err)
	}
	if _, err := f.admin.Exec(f.base.ctx, `UPDATE app.analytics_snapshots SET synced_at=clock_timestamp()-INTERVAL '91 days' WHERE connection_id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	view, err := f.analytics.ReadCommerce(f.base.ctx, f.actor, clientAID, c.ID, commerceStart, commerceEnd, "USD")
	if err != nil || view.Data != nil || !view.Status.Stale {
		t.Fatal("expired commerce snapshot remains visible")
	}
	if err := f.analytics.Prune(f.base.ctx); err != nil {
		t.Fatal("audited commerce retention failed", err)
	}
	var count, audits int
	if f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.analytics_snapshots),(SELECT count(*) FROM app.audit_events WHERE resource_kind='analytics_snapshot' AND event_name='analytics_snapshot.deleted')`).Scan(&count, &audits) != nil || count != 0 || audits != 1 {
		t.Fatal("retention removed wrong records or omitted audit")
	}
	if _, err := provider(t, f.base).DownTo(f.base.ctx, 23); err == nil {
		t.Fatal("rollback destroyed retained commerce history")
	}
}

func TestCommerceAndGA4ShareReplicaAdmissionAndLeaseGenerationFences(t *testing.T) {
	f := newCommerceFixture(t)
	ga4Connection := f.create(t, "123456789")
	key := analyticsKey(t)
	defer clear(key)
	f.setup(t, ga4Connection, key)
	c := f.createCommerce(t, "https://one.example.com")
	f.setupCommerce(t, c)
	other := f.createCommerce(t, "https://two.example.com")
	f.setupCommerce(t, other)
	ga4Claim := f.claim(t)
	claim, err := f.claimProvider("woocommerce")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.claimProvider("woocommerce"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("mixed providers exceeded global two leases", err)
	}
	if _, err := f.claimProvider("ga4"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("GA4 admission ignored commerce leases", err)
	}
	if _, err := f.admin.Exec(f.base.ctx, `UPDATE app.analytics_sync_jobs SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1`, claim.id); err != nil {
		t.Fatal(err)
	}
	newClaim, err := f.claimProvider("woocommerce")
	if err != nil || newClaim.id != claim.id || *newClaim.lease == *claim.lease {
		t.Fatal("expired lease not recovered", err)
	}
	w := syntheticCommerceWorkspace(t, c.ID)
	raw, _ := json.Marshal(w)
	if err := f.finishRaw(t, claim, "woocommerce", raw); err == nil {
		t.Fatal("expired lease published")
	}
	if _, err := f.analytics.SetupCommerce(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, "3", commerceStart, commerceEnd, "USD", commerceKey()); err != nil {
		t.Fatal("credential replacement failed", err)
	}
	if err := f.finishRaw(t, newClaim, "woocommerce", raw); err == nil {
		t.Fatal("replaced generation published")
	}
	var allowed bool
	if f.runtime.QueryRow(f.base.ctx, `SELECT app.analytics_job_allowed($1::uuid,$2::uuid)`, newClaim.id, *newClaim.lease).Scan(&allowed) != nil || allowed {
		t.Fatal("replacement kept old credential fence")
	}
	if f.runtime.QueryRow(f.base.ctx, `SELECT app.analytics_job_allowed($1::uuid,$2::uuid)`, ga4Claim.id, *ga4Claim.lease).Scan(&allowed) != nil || !allowed {
		t.Fatal("commerce replacement broke independent GA4 job")
	}
}

func TestCommerceHTTPAuthCSRFIsolationAndCredentialPrivacy(t *testing.T) {
	f := newCommerceFixture(t)
	path := metadataPath(clientAID) + "/woocommerce"
	body := map[string]string{"origin": "https://shop.example.com"}
	assertStatus(t, f.request(t, nil, "POST", path, body, nil), 401, "authentication_required")
	response := f.request(t, &f.login, "POST", path, body, nil)
	assertStatus(t, response, 201, "")
	var created struct {
		Data connections.Connection `json:"data"`
	}
	if json.Unmarshal(response.Body.Bytes(), &created) != nil {
		t.Fatal("create JSON unavailable")
	}
	setupPath := metadataPath(clientAID) + "/" + created.Data.ID + "/woocommerce/credentials"
	setup := map[string]string{"revision": "1", "start": commerceStart, "end": commerceEnd, "currency": "USD", "consumer_key": "ck_" + strings.Repeat("a", 40), "consumer_secret": "cs_" + strings.Repeat("b", 40)}
	for _, guard := range []struct {
		alter  func(*http.Request)
		status int
	}{
		{func(r *http.Request) { r.Header.Del("X-CSRF-Token") }, 403},
		{func(r *http.Request) { r.Header.Set("Origin", "https://untrusted.example.com") }, 403},
		{func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		{func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(`{"revision":"1","revision":"1"}`)) }, 400},
		{func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(strings.Repeat(" ", 5<<10))) }, 400},
	} {
		assertStatus(t, f.request(t, &f.login, "POST", setupPath, setup, guard.alter), guard.status, "")
	}
	assertStatus(t, f.request(t, &f.login, "POST", setupPath, setup, nil), 202, "")
	assertStatus(t, f.request(t, &f.login, "POST", setupPath, setup, nil), 409, "conflict")
	readPath := "clients/" + clientAID + "/commerce/" + created.Data.ID + "?start=" + commerceStart + "&end=" + commerceEnd + "&currency=USD"
	response = f.request(t, &f.login, "GET", readPath, nil, nil)
	assertStatus(t, response, 200, "")
	if response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Body.String(), `"data":null`) || !strings.Contains(response.Body.String(), `"state":"queued"`) {
		t.Fatal("queued HTTP report fabricated success")
	}
	for _, private := range []string{"shop.example.com", setup["consumer_key"], setup["consumer_secret"]} {
		if strings.Contains(response.Body.String(), private) || strings.Contains(f.logs.String(), private) {
			t.Fatal("HTTP exposed private fields")
		}
	}
	viewer, _ := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsView}, clientAID)
	if _, err := f.analytics.ReadCommerce(f.base.ctx, viewer, clientAID, created.Data.ID, commerceStart, commerceEnd, "USD"); err != analytics.ErrMissing {
		t.Fatal("integration view implied report grant")
	}
	if _, err := f.analytics.CreateCommerce(correlation.New(f.base.ctx), viewer, clientAID, "https://other.example.com"); err != analytics.ErrMissing {
		t.Fatal("viewer created store")
	}
}

func TestCommerceRevocationAndPublicationAuditFailureCannotStoreObservations(t *testing.T) {
	f := newCommerceFixture(t)
	c := f.createCommerce(t, "https://shop.example.com")
	requester, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage, authorization.AnalyticsView}, clientAID)
	key := commerceKey()
	defer clear(key)
	if _, err := f.analytics.SetupCommerce(correlation.New(f.base.ctx), requester, clientAID, c.ID, "1", commerceStart, commerceEnd, "USD", key); err != nil {
		t.Fatal(err)
	}
	claim, err := f.claimProvider("woocommerce")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.authorizer.RevokeRole(correlation.New(f.base.ctx), f.actor, assignment); err != nil {
		t.Fatal(err)
	}
	var allowed bool
	if f.runtime.QueryRow(f.base.ctx, `SELECT app.analytics_job_allowed($1::uuid,$2::uuid)`, claim.id, *claim.lease).Scan(&allowed) != nil || allowed {
		t.Fatal("revoked requester kept credential/network fence")
	}
	w := syntheticCommerceWorkspace(t, c.ID)
	raw, _ := json.Marshal(w)
	if err := f.finishRaw(t, claim, "woocommerce", raw); err != nil {
		t.Fatal("safe revoked outcome failed", err)
	}
	var state, reason string
	if f.admin.QueryRow(f.base.ctx, `SELECT state,reason FROM app.analytics_sync_jobs WHERE id=$1`, claim.id).Scan(&state, &reason) != nil || state != "failed" || reason != "authorization_required" {
		t.Fatal("revoked report published success")
	}
	if _, err := f.analytics.ReadCommerce(f.base.ctx, requester, clientAID, c.ID, commerceStart, commerceEnd, "USD"); err != analytics.ErrMissing {
		t.Fatal("revoked report remained visible")
	}
	if _, err := f.analytics.EnqueueCommerce(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, "3", commerceStart, commerceEnd, "USD"); err != nil {
		t.Fatal(err)
	}
	claim, err = f.claimProvider("woocommerce")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(f.base.ctx, `CREATE FUNCTION app.commerce_fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.resource_kind='analytics_snapshot' THEN RAISE EXCEPTION 'Synthetic publication audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER commerce_fixture_audit_failure BEFORE INSERT ON app.audit_events FOR EACH ROW EXECUTE FUNCTION app.commerce_fixture_audit_failure()`); err != nil {
		t.Fatal(err)
	}
	if err := f.finishRaw(t, claim, "woocommerce", raw); err == nil {
		t.Fatal("failed audit published complete report")
	}
	var count int
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.analytics_snapshots WHERE connection_id=$1`, c.ID).Scan(&count) != nil || count != 0 {
		t.Fatal("audit failure left partial data")
	}
}

func TestCommerceSetupAuditFailureBurnsBudgetWithoutCredentialOrQueuedJob(t *testing.T) {
	f := newCommerceFixture(t)
	c := f.createCommerce(t, "https://shop.example.com")
	if _, err := f.admin.Exec(f.base.ctx, `CREATE FUNCTION app.commerce_fixture_setup_failure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.resource_kind='analytics_sync' THEN RAISE EXCEPTION 'Synthetic setup audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER commerce_fixture_setup_failure BEFORE INSERT ON app.audit_events FOR EACH ROW EXECUTE FUNCTION app.commerce_fixture_setup_failure()`); err != nil {
		t.Fatal(err)
	}
	key := commerceKey()
	defer clear(key)
	if _, err := f.analytics.SetupCommerce(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, "1", commerceStart, commerceEnd, "USD", key); err != analytics.ErrUnavailable {
		t.Fatal("setup audit failure did not refuse")
	}
	if units, events := f.accounting(t); units != 1 || events != 1 {
		t.Fatal("failed setup refunded burned encryption unit")
	}
	var jobs, credentials int
	if f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.analytics_sync_jobs),(SELECT count(*) FROM app.integration_credentials WHERE connection_id=$1)`, c.ID).Scan(&jobs, &credentials) != nil || jobs != 0 || credentials != 0 {
		t.Fatal("failed setup stored credential or work")
	}
}

func TestCommerceWorkerRejectsMalformedSavedKeyWithoutNetworkOrAutomaticRetry(t *testing.T) {
	f := newCommerceFixture(t)
	c := f.createCommerce(t, "https://shop.example.com")
	f.setupCommerce(t, c)
	claim, err := f.claimProvider("woocommerce")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.finishRaw(t, claim, "woocommerce", nil); err != nil {
		t.Fatal(err)
	}
	checkpoint, err := f.vault.Inspect(correlation.New(f.base.ctx), f.actor, clientAID, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint, err = f.vault.Replace(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, checkpoint, []byte("synthetic-invalid-read-key"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.analytics.EnqueueCommerce(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, fmt.Sprint(checkpoint.ConnectionRevision), commerceStart, commerceEnd, "USD"); err != nil {
		t.Fatal(err)
	}
	worker, err := analytics.NewWorker(f.analytics)
	if err != nil {
		t.Fatal(err)
	}
	if didWork, err := worker.RunOnce(f.base.ctx); err != nil || !didWork {
		t.Fatal("worker did not record malformed-key failure", err)
	}
	view, err := f.analytics.ReadCommerce(f.base.ctx, f.actor, clientAID, c.ID, commerceStart, commerceEnd, "USD")
	if err != nil || view.Data != nil || view.Status.State != "failed" || view.Status.Reason == nil || *view.Status.Reason != "provider_unavailable" {
		t.Fatal("malformed key manufactured observations", err)
	}
	if didWork, err := worker.RunOnce(f.base.ctx); err != nil || didWork {
		t.Fatal("provider failure retried automatically", err)
	}
}
