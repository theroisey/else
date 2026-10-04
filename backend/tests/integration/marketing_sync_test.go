//go:build integration

package integration

import (
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
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/connections"
	"github.com/theroisey/else/backend/internal/integrations/providers/metaads"
)

const marketingFunctions = `app.marketing_connection_create(uuid,uuid,uuid,text),
app.marketing_sync_enqueue(uuid,uuid,uuid,bigint,bigint,bigint,date,date,uuid,boolean),
app.marketing_sync_cancel(uuid,uuid,uuid),app.marketing_sync_finish(uuid,uuid,jsonb),
app.marketing_workspace_read(uuid,uuid,uuid,date,date),app.marketing_connection_list(uuid,uuid,uuid,integer)`
const marketingSince = "2026-10-01"
const marketingUntil = "2026-10-03"
const marketingToken = "SyntheticReadTokenFixture123456"

func newMarketingFixture(t *testing.T) *analyticsFixture {
	t.Helper()
	f := newCommerceFixture(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+marketingFunctions+` TO `+f.runtimeRole); err != nil {
		t.Fatal("marketing entrypoints unavailable")
	}
	return f
}

func (f *analyticsFixture) createMarketing(t *testing.T, account string) connections.Connection {
	t.Helper()
	c, err := f.analytics.CreateMarketing(correlation.New(f.base.ctx), f.actor, clientAID, account)
	if err != nil || c.Provider != "meta_ads" || c.State != "pending" || c.Revision != "1" {
		t.Fatal("pending marketing create failed", err)
	}
	return c
}

func (f *analyticsFixture) setupMarketing(t *testing.T, c connections.Connection) analytics.Queued {
	t.Helper()
	key := []byte(marketingToken)
	defer clear(key)
	q, err := f.analytics.SetupMarketing(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, c.Revision, marketingSince, marketingUntil, key)
	if err != nil || q.ConnectionRevision != "3" || q.State != "queued" {
		t.Fatal("encrypted marketing setup failed", err)
	}
	return q
}

// Synthetic minimal observations exercise exact normalization and real storage;
// they do not establish actual Meta account access or legal ownership.
func syntheticMarketingWorkspace(t *testing.T, connection string) metaads.Workspace {
	t.Helper()
	e := metaads.Expectation{ClientID: clientAID, ConnectionID: connection, AccountID: "123456789", Currency: "USD", Timezone: "America/New_York", Since: marketingSince, Until: marketingUntil}
	r, err := metaads.Normalize(e, [][]byte{[]byte(`{"data":[{"account_id":"123456789","account_currency":"USD","date_start":"2026-10-01","date_stop":"2026-10-01","spend":"9007199254740993.123456","impressions":"9007199254740993","clicks":"3"},{"account_id":"123456789","account_currency":"USD","date_start":"2026-10-03","date_stop":"2026-10-03","spend":"2","impressions":"101","clicks":"1"}]}`)})
	if err != nil {
		t.Fatal("synthetic marketing normalization failed")
	}
	stamp := time.Now().UTC().Truncate(time.Microsecond)
	w := metaads.Workspace{Report: r, CollectedFrom: stamp, CollectedThrough: stamp.Add(time.Microsecond)}
	if !metaads.ValidWorkspace(w, metaads.Request{ClientID: clientAID, ConnectionID: connection, AccountID: e.AccountID, Since: e.Since, Until: e.Until}) {
		t.Fatal("synthetic marketing workspace invalid")
	}
	return w
}

func TestMarketingEncryptedSetupExactStoredReadAndFailedRefresh(t *testing.T) {
	f := newMarketingFixture(t)
	c := f.createMarketing(t, "123456789")
	queued := f.setupMarketing(t, c)
	claim, err := f.claimProvider("meta_ads")
	if err != nil || claim.id != queued.JobID || claim.state != "running" || claim.lease == nil {
		t.Fatal("marketing claim unavailable", err)
	}
	w := syntheticMarketingWorkspace(t, c.ID)
	raw, _ := json.Marshal(w)
	defer clear(raw)
	if err := f.finishRaw(t, claim, "meta_ads", raw); err != nil {
		t.Fatal("complete publication failed", err)
	}
	reader, _ := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.AnalyticsView}, clientAID)
	view, err := f.analytics.ReadMarketing(f.base.ctx, reader, clientAID, c.ID, marketingSince, marketingUntil)
	if err != nil || view.Data == nil || view.Status.State != "succeeded" || view.Status.Stale || !reflect.DeepEqual(*view.Data, w) {
		t.Fatal("exact measured report differs", err)
	}
	if _, err := f.connections.Detail(f.base.ctx, reader, clientAID, c.ID); err != connections.ErrMissing {
		t.Fatal("report grant implied integration view")
	}
	page, err := f.analytics.ListMarketing(f.base.ctx, reader, clientAID, "")
	if err != nil || len(page.Data) != 2 || !(page.Data[0].ID == c.ID || page.Data[1].ID == c.ID) {
		t.Fatal("independent marketing catalog failed", err)
	}
	if _, err := f.analytics.ReadMarketing(f.base.ctx, reader, clientBID, c.ID, marketingSince, marketingUntil); err != analytics.ErrMissing {
		t.Fatal("cross-client report exposed")
	}
	other, err := f.analytics.ReadMarketing(f.base.ctx, reader, clientAID, c.ID, marketingSince, marketingSince)
	if err != nil || other.Data != nil || other.Status.State != "not_synced" {
		t.Fatal("period was silently inferred")
	}
	for _, revision := range []string{"4", "5"} {
		if _, err := f.analytics.EnqueueMarketing(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, revision, marketingSince, marketingUntil); err != nil {
			t.Fatal("explicit refresh failed", err)
		}
		claim, err = f.claimProvider("meta_ads")
		if err != nil {
			t.Fatal(err)
		}
		value := raw
		if revision == "5" {
			value = nil
		}
		if err := f.finishRaw(t, claim, "meta_ads", value); err != nil {
			t.Fatal(err)
		}
	}
	view, err = f.analytics.ReadMarketing(f.base.ctx, reader, clientAID, c.ID, marketingSince, marketingUntil)
	if err != nil || view.Data == nil || view.Status.State != "failed" || view.Status.Reason == nil || *view.Status.Reason != "provider_unavailable" || view.Status.SyncedAt == nil {
		t.Fatal("failed refresh erased prior report or hid failure", err)
	}
	var count, revision int
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*),max(revision) FROM app.analytics_snapshots WHERE connection_id=$1`, c.ID).Scan(&count, &revision) != nil || count != 1 || revision != 2 {
		t.Fatal("refresh duplicated report")
	}
	if units, events := f.accounting(t); units != 1 || events != 1 {
		t.Fatal("setup lost irreversible accounting")
	}
	encoded, _ := json.Marshal(view)
	for _, private := range []string{"123456789", marketingToken, "access_token", "lease_token", "generation", "requested_by"} {
		if strings.Contains(string(encoded), private) || strings.Contains(f.logs.String(), private) {
			t.Fatal("private context leaked")
		}
	}
}

func TestMarketingSQLValidationRetentionAndRollbackProtection(t *testing.T) {
	f := newMarketingFixture(t)
	c := f.createMarketing(t, "123456789")
	f.setupMarketing(t, c)
	claim, err := f.claimProvider("meta_ads")
	if err != nil {
		t.Fatal(err)
	}
	w := syntheticMarketingWorkspace(t, c.ID)
	raw, _ := json.Marshal(w)
	defer clear(raw)
	for _, mutation := range []string{
		strings.Replace(string(raw), `"report":{`, `"report":{"account_id":"123456789",`, 1),
		strings.Replace(string(raw), `"days":[{`, `"days":[{"actions":[],`, 1),
		strings.Replace(string(raw), clientAID, clientBID, 1),
		strings.Replace(string(raw), `"spend_decimal":"9007199254740993.123456"`, `"spend_decimal":"9007199254740993.123457"`, 1),
		strings.Replace(string(raw), `"ctr_percent":"0.000000"`, `"ctr_percent":null`, 1),
		strings.Replace(string(raw), `"date":"2026-10-01"`, `"date":"2026-09-30"`, 1),
		strings.Replace(string(raw), `"currency":"USD"`, `"currency":"usd"`, 1),
		strings.Replace(string(raw), `"timezone":"America/New_York"`, `"timezone":"Local"`, 1),
		strings.Replace(string(raw), `"graph_version":"v26.0"`, `"graph_version":"v21.0"`, 1),
		strings.Replace(string(raw), `"attribution_status":"unavailable"`, `"attribution_status":"measured"`, 1),
	} {
		if mutation == string(raw) {
			t.Fatal("SQL mutation did not change fixture")
		}
		var valid bool
		if f.admin.QueryRow(f.base.ctx, `SELECT app.marketing_workspace_valid($1::jsonb,$2::uuid,$3::uuid,$4::date,$5::date)`, mutation, clientAID, c.ID, marketingSince, marketingUntil).Scan(&valid) != nil || valid {
			t.Fatal("SQL admitted private/inexact/misbound report")
		}
		if err := f.finishRaw(t, claim, "meta_ads", []byte(mutation)); err == nil {
			t.Fatal("invalid report published")
		}
	}
	if err := f.finishRaw(t, claim, "meta_ads", raw); err != nil {
		t.Fatal("valid report failed after refused writes", err)
	}
	if _, err := f.admin.Exec(f.base.ctx, `UPDATE app.analytics_snapshots SET synced_at=clock_timestamp()-INTERVAL '91 days' WHERE connection_id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	view, err := f.analytics.ReadMarketing(f.base.ctx, f.actor, clientAID, c.ID, marketingSince, marketingUntil)
	if err != nil || view.Data != nil || !view.Status.Stale {
		t.Fatal("expired snapshot remained visible")
	}
	if err := f.analytics.Prune(f.base.ctx); err != nil {
		t.Fatal(err)
	}
	var count, audits int
	if f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.analytics_snapshots),(SELECT count(*) FROM app.audit_events WHERE resource_kind='analytics_snapshot' AND event_name='analytics_snapshot.deleted')`).Scan(&count, &audits) != nil || count != 0 || audits != 1 {
		t.Fatal("retention lost audit or removed wrong records")
	}
	if _, err := provider(t, f.base).DownTo(f.base.ctx, 24); err == nil {
		t.Fatal("rollback destroyed marketing history")
	}
}

func TestMarketingSharesGlobalAdmissionReplacementAndExpiredLeaseFences(t *testing.T) {
	f := newMarketingFixture(t)
	g := f.create(t, "987654321")
	key := analyticsKey(t)
	defer clear(key)
	f.setup(t, g, key)
	c := f.createMarketing(t, "123456789")
	f.setupMarketing(t, c)
	wc := f.createCommerce(t, "https://shop.example.com")
	f.setupCommerce(t, wc)
	gClaim := f.claim(t)
	claim, err := f.claimProvider("meta_ads")
	if err != nil {
		t.Fatal(err)
	}
	for _, provider := range []string{"ga4", "woocommerce", "meta_ads"} {
		if _, err := f.claimProvider(provider); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("provider exceeded two global leases", err)
		}
	}
	if _, err := f.admin.Exec(f.base.ctx, `UPDATE app.analytics_sync_jobs SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1`, claim.id); err != nil {
		t.Fatal(err)
	}
	newClaim, err := f.claimProvider("meta_ads")
	if err != nil || *newClaim.lease == *claim.lease {
		t.Fatal("expired lease not recovered", err)
	}
	w := syntheticMarketingWorkspace(t, c.ID)
	raw, _ := json.Marshal(w)
	if err := f.finishRaw(t, claim, "meta_ads", raw); err == nil {
		t.Fatal("expired lease published")
	}
	if _, err := f.analytics.SetupMarketing(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, "3", marketingSince, marketingUntil, []byte(marketingToken)); err != nil {
		t.Fatal("replacement failed", err)
	}
	if err := f.finishRaw(t, newClaim, "meta_ads", raw); err == nil {
		t.Fatal("replaced generation published")
	}
	var allowed bool
	if f.runtime.QueryRow(f.base.ctx, `SELECT app.analytics_job_allowed($1::uuid,$2::uuid)`, newClaim.id, *newClaim.lease).Scan(&allowed) != nil || allowed {
		t.Fatal("replacement kept old fence")
	}
	if f.runtime.QueryRow(f.base.ctx, `SELECT app.analytics_job_allowed($1::uuid,$2::uuid)`, gClaim.id, *gClaim.lease).Scan(&allowed) != nil || !allowed {
		t.Fatal("replacement broke independent GA4 fence")
	}
}

func TestMarketingHTTPAuthCSRFIsolationAndTokenPrivacy(t *testing.T) {
	f := newMarketingFixture(t)
	path := metadataPath(clientAID) + "/meta_ads"
	body := map[string]string{"account_id": "123456789"}
	assertStatus(t, f.request(t, nil, "POST", path, body, nil), 401, "authentication_required")
	response := f.request(t, &f.login, "POST", path, body, nil)
	assertStatus(t, response, 201, "")
	var created struct {
		Data connections.Connection `json:"data"`
	}
	if json.Unmarshal(response.Body.Bytes(), &created) != nil {
		t.Fatal("create JSON unavailable")
	}
	setupPath := metadataPath(clientAID) + "/" + created.Data.ID + "/meta_ads/credentials"
	setup := map[string]string{"revision": "1", "since": marketingSince, "until": marketingUntil, "access_token": marketingToken}
	for _, guard := range []struct {
		alter  func(*http.Request)
		status int
	}{
		{func(r *http.Request) { r.Header.Del("X-CSRF-Token") }, 403},
		{func(r *http.Request) { r.Header.Set("Origin", "https://untrusted.example.com") }, 403},
		{func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		{func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(`{"revision":"1","revision":"1"}`)) }, 400},
		{func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(strings.Repeat(" ", 9<<10))) }, 400},
	} {
		assertStatus(t, f.request(t, &f.login, "POST", setupPath, setup, guard.alter), guard.status, "")
	}
	assertStatus(t, f.request(t, &f.login, "POST", setupPath, setup, nil), 202, "")
	assertStatus(t, f.request(t, &f.login, "POST", setupPath, setup, nil), 409, "conflict")
	readPath := "clients/" + clientAID + "/marketing/" + created.Data.ID + "?since=" + marketingSince + "&until=" + marketingUntil
	response = f.request(t, &f.login, "GET", readPath, nil, nil)
	assertStatus(t, response, 200, "")
	if response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Body.String(), `"data":null`) || !strings.Contains(response.Body.String(), `"state":"queued"`) {
		t.Fatal("queued report fabricated success")
	}
	if strings.Contains(response.Body.String(), marketingToken) || strings.Contains(f.logs.String(), marketingToken) {
		t.Fatal("token exposed")
	}
	viewer, _ := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsView}, clientAID)
	if _, err := f.analytics.ReadMarketing(f.base.ctx, viewer, clientAID, created.Data.ID, marketingSince, marketingUntil); err != analytics.ErrMissing {
		t.Fatal("integration view implied report grant")
	}
	if _, err := f.analytics.CreateMarketing(correlation.New(f.base.ctx), viewer, clientAID, "123456788"); err != analytics.ErrMissing {
		t.Fatal("viewer created account")
	}
}

func TestMarketingRevocationAndPublicationAuditFailureCannotStoreObservations(t *testing.T) {
	f := newMarketingFixture(t)
	c := f.createMarketing(t, "123456789")
	requester, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage, authorization.AnalyticsView}, clientAID)
	if _, err := f.analytics.SetupMarketing(correlation.New(f.base.ctx), requester, clientAID, c.ID, "1", marketingSince, marketingUntil, []byte(marketingToken)); err != nil {
		t.Fatal(err)
	}
	claim, err := f.claimProvider("meta_ads")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.authorizer.RevokeRole(correlation.New(f.base.ctx), f.actor, assignment); err != nil {
		t.Fatal(err)
	}
	var allowed bool
	if f.runtime.QueryRow(f.base.ctx, `SELECT app.analytics_job_allowed($1::uuid,$2::uuid)`, claim.id, *claim.lease).Scan(&allowed) != nil || allowed {
		t.Fatal("revoked requester retained fence")
	}
	w := syntheticMarketingWorkspace(t, c.ID)
	raw, _ := json.Marshal(w)
	if err := f.finishRaw(t, claim, "meta_ads", raw); err != nil {
		t.Fatal(err)
	}
	var state, reason string
	if f.admin.QueryRow(f.base.ctx, `SELECT state,reason FROM app.analytics_sync_jobs WHERE id=$1`, claim.id).Scan(&state, &reason) != nil || state != "failed" || reason != "authorization_required" {
		t.Fatal("revoked publication succeeded")
	}
	if _, err := f.analytics.ReadMarketing(f.base.ctx, requester, clientAID, c.ID, marketingSince, marketingUntil); err != analytics.ErrMissing {
		t.Fatal("revoked report visible")
	}
	if _, err := f.analytics.EnqueueMarketing(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, "3", marketingSince, marketingUntil); err != nil {
		t.Fatal(err)
	}
	claim, err = f.claimProvider("meta_ads")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(f.base.ctx, `CREATE FUNCTION app.marketing_fixture_failure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.resource_kind='analytics_snapshot' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER marketing_fixture_failure BEFORE INSERT ON app.audit_events FOR EACH ROW EXECUTE FUNCTION app.marketing_fixture_failure()`); err != nil {
		t.Fatal(err)
	}
	if err := f.finishRaw(t, claim, "meta_ads", raw); err == nil {
		t.Fatal("failed audit published report")
	}
	var count int
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.analytics_snapshots WHERE connection_id=$1`, c.ID).Scan(&count) != nil || count != 0 {
		t.Fatal("audit failure left partial data")
	}
}

func TestMarketingSetupAuditFailureBurnsBudgetWithoutCredentialOrJob(t *testing.T) {
	f := newMarketingFixture(t)
	c := f.createMarketing(t, "123456789")
	if _, err := f.admin.Exec(f.base.ctx, `CREATE FUNCTION app.marketing_fixture_failure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.resource_kind='analytics_sync' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER marketing_fixture_failure BEFORE INSERT ON app.audit_events FOR EACH ROW EXECUTE FUNCTION app.marketing_fixture_failure()`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.analytics.SetupMarketing(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, "1", marketingSince, marketingUntil, []byte(marketingToken)); err != analytics.ErrUnavailable {
		t.Fatal("setup audit failure not refused", err)
	}
	if units, events := f.accounting(t); units != 1 || events != 1 {
		t.Fatal("failed setup refunded budget")
	}
	var jobs, credentials int
	if f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.analytics_sync_jobs),(SELECT count(*) FROM app.integration_credentials WHERE connection_id=$1)`, c.ID).Scan(&jobs, &credentials) != nil || jobs != 0 || credentials != 0 {
		t.Fatal("failed setup stored credential or work")
	}
}

func TestMarketingWorkerRejectsMalformedTokenWithoutNetworkOrAutomaticRetry(t *testing.T) {
	f := newMarketingFixture(t)
	c := f.createMarketing(t, "123456789")
	f.setupMarketing(t, c)
	claim, err := f.claimProvider("meta_ads")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.finishRaw(t, claim, "meta_ads", nil); err != nil {
		t.Fatal(err)
	}
	checkpoint, err := f.vault.Inspect(correlation.New(f.base.ctx), f.actor, clientAID, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint, err = f.vault.Replace(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, checkpoint, []byte("synthetic invalid token"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.analytics.EnqueueMarketing(correlation.New(f.base.ctx), f.actor, clientAID, c.ID, fmt.Sprint(checkpoint.ConnectionRevision), marketingSince, marketingUntil); err != nil {
		t.Fatal(err)
	}
	worker, err := analytics.NewWorker(f.analytics)
	if err != nil {
		t.Fatal(err)
	}
	if didWork, err := worker.RunOnce(f.base.ctx); err != nil || !didWork {
		t.Fatal("worker did not record malformed-token failure", err)
	}
	view, err := f.analytics.ReadMarketing(f.base.ctx, f.actor, clientAID, c.ID, marketingSince, marketingUntil)
	if err != nil || view.Data != nil || view.Status.State != "failed" || view.Status.Reason == nil || *view.Status.Reason != "provider_unavailable" {
		t.Fatal("malformed token manufactured observations", err)
	}
	if didWork, err := worker.RunOnce(f.base.ctx); err != nil || didWork {
		t.Fatal("failure retried automatically", err)
	}
}
