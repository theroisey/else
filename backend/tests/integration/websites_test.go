//go:build integration

package integration

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/clients"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
)

func websiteFixture(t *testing.T) *clientFixture {
	f := newClientFixture(t)
	_, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION app.website_list(uuid,uuid,uuid,integer,text),app.website_read(uuid,uuid,uuid),app.website_write(uuid,uuid,uuid,bigint,text,jsonb),app.website_connections(uuid,uuid,uuid,uuid,integer),app.website_connection_binding(uuid,uuid,uuid,uuid,bigint,boolean),app.website_connection_allowed(uuid,uuid,uuid,uuid,boolean),app.website_activity(uuid,uuid,uuid,uuid,integer) TO `+f.runtimeRole)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func TestWebsitesLifecycleScopePrimaryAndAudit(t *testing.T) {
	f := websiteFixture(t)
	ctx := correlation.New(f.base.ctx)
	first, err := f.records.WriteWebsite(ctx, f.actor, clientAID, "", 0, "create", clients.WebsiteProfile{Name: "Synthetic main", URL: "example.com"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.records.WriteWebsite(ctx, f.actor, clientAID, "", 0, "create", clients.WebsiteProfile{Name: "Synthetic shop", URL: "https://shop.example.com/store"})
	if err != nil {
		t.Fatal(err)
	}
	page, err := f.records.Websites(ctx, f.actor, clientAID, "", "active", 1)
	if err != nil || len(page.Data) != 1 || page.Page.NextCursor == nil {
		t.Fatal("website pagination failed", err)
	}
	next, err := f.records.Websites(ctx, f.actor, clientAID, *page.Page.NextCursor, "active", 1)
	if err != nil || len(next.Data) != 1 || next.Data[0].ID == page.Data[0].ID {
		t.Fatal("website cursor repeated or lost a record")
	}
	if _, err = f.records.Website(ctx, f.actor, clientBID, first.ID); !errors.Is(err, clients.ErrMissing) {
		t.Fatal("cross-client detail exposed")
	}
	if _, err = f.records.WriteWebsite(ctx, f.actor, clientBID, first.ID, 1, "archive", clients.WebsiteProfile{}); !errors.Is(err, clients.ErrMissing) {
		t.Fatal("cross-client write allowed")
	}
	viewer := f.user(t, "website.viewer@example.com")
	if _, err = f.authorizer.AssignRole(ctx, f.actor, viewer.ID, authorization.ViewerRoleID, authorization.Client, clientAID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.records.Website(ctx, viewer.ID, clientAID, first.ID); err != nil {
		t.Fatal("scoped reader denied", err)
	}
	if _, err = f.records.Website(ctx, viewer.ID, clientAID, second.ID); err != nil {
		t.Fatal("second scoped website denied", err)
	}
	if _, err = f.records.WriteWebsite(ctx, viewer.ID, clientAID, first.ID, 1, "primary", clients.WebsiteProfile{}); !errors.Is(err, clients.ErrMissing) {
		t.Fatal("reader changed primary")
	}
	if _, err = f.records.Websites(ctx, viewer.ID, clientBID, "", "all", 25); !errors.Is(err, clients.ErrMissing) {
		t.Fatal("hidden client list exposed")
	}
	for _, id := range []string{first.ID, second.ID} {
		if _, err = f.records.WriteWebsite(ctx, f.actor, clientAID, id, 1, "primary", clients.WebsiteProfile{}); err != nil {
			t.Fatal(err)
		}
	}
	a, err := f.records.Website(ctx, f.actor, clientAID, first.ID)
	if err != nil || a.IsPrimary || a.Revision != 3 {
		t.Fatal("previous primary not demoted with revision", err)
	}
	b, err := f.records.Website(ctx, f.actor, clientAID, second.ID)
	if err != nil || !b.IsPrimary || b.Revision != 2 {
		t.Fatal("new primary not set", err)
	}
	if _, err = f.records.WriteWebsite(ctx, f.actor, clientAID, first.ID, 2, "update", clients.WebsiteProfile{Name: "Stale", URL: "example.com"}); !errors.Is(err, clients.ErrConflict) {
		t.Fatal("stale edit overwritten")
	}
	if _, err = f.records.WriteWebsite(ctx, f.actor, clientAID, second.ID, 2, "archive", clients.WebsiteProfile{}); err != nil {
		t.Fatal(err)
	}
	b, err = f.records.Website(ctx, f.actor, clientAID, second.ID)
	if err != nil || b.Status != "archived" || b.IsPrimary || b.URL != "https://shop.example.com/store" {
		t.Fatal("archive lost property/history", err)
	}
	if _, err = f.records.WriteWebsite(ctx, f.actor, clientAID, second.ID, 3, "primary", clients.WebsiteProfile{}); !errors.Is(err, clients.ErrConflict) {
		t.Fatal("archived website changed")
	}
	var events int
	var payload string
	if err = f.admin.QueryRow(ctx, `SELECT count(*),coalesce(string_agg(before_state::text||after_state::text||metadata::text,''),'') FROM app.audit_events WHERE resource_kind='website' AND client_id=$1::uuid`, clientAID).Scan(&events, &payload); err != nil || events != 6 || strings.Contains(payload, "example.com") {
		t.Fatal("audit missing, duplicate, or includes profile content", err, events)
	}
	activity, _, err := f.records.WebsiteActivity(ctx, f.actor, clientAID, second.ID, "", 25)
	if err != nil || len(activity) != 3 {
		t.Fatal("website activity projection failed", err)
	}
	if _, err = f.admin.Exec(ctx, `UPDATE app.client_websites SET is_primary=true WHERE id=$1::uuid`, second.ID); err == nil {
		t.Fatal("database primary/archive invariant bypassed")
	}
	if _, err := provider(t, f.base).DownTo(ctx, 25); err == nil {
		t.Fatal("populated website rollback discarded history")
	}
}
func TestWebsiteConcurrentPrimaryAndRevision(t *testing.T) {
	f := websiteFixture(t)
	ctx := correlation.New(f.base.ctx)
	first, err := f.records.WriteWebsite(ctx, f.actor, clientAID, "", 0, "create", clients.WebsiteProfile{Name: "A", URL: "a.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.records.WriteWebsite(ctx, f.actor, clientAID, "", 0, "create", clients.WebsiteProfile{Name: "B", URL: "b.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, id := range []string{first.ID, second.ID} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_, err := f.records.WriteWebsite(ctx, f.actor, clientAID, id, 1, "primary", clients.WebsiteProfile{})
			results <- err
		}(id)
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil && !errors.Is(err, clients.ErrConflict) {
			t.Fatal(err)
		}
	}
	var count int
	if err = f.admin.QueryRow(ctx, `SELECT count(*) FROM app.client_websites WHERE client_id=$1::uuid AND is_primary`, clientAID).Scan(&count); err != nil || count != 1 {
		t.Fatal("concurrent primary invariant failed", err)
	}
}
func TestWebsiteLegacyMigrationPreservesAllValues(t *testing.T) {
	f := newFixture(t)
	p := provider(t, f)
	if _, err := p.Up(f.ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DownTo(f.ctx, 25); err != nil {
		t.Fatal(err)
	}
	conn := connection(t, f)
	ids := []string{"71000000-0000-4000-8000-000000000001", "71000000-0000-4000-8000-000000000002", "71000000-0000-4000-8000-000000000003"}
	urls := []string{"https://shop.example.com", "", "legacy value retained"}
	for i, id := range ids {
		if _, err := conn.Exec(f.ctx, `INSERT INTO app.client_scopes VALUES($1::uuid);`, id); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(f.ctx, `INSERT INTO app.clients(id,name,website) VALUES($1::uuid,'Synthetic legacy',$2)`, id, urls[i]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := p.Up(f.ctx); err != nil {
		t.Fatal(err)
	}
	for i, id := range ids {
		var value string
		var count int
		if err := conn.QueryRow(f.ctx, `SELECT website,(SELECT count(*) FROM app.client_websites WHERE client_id=$1::uuid) FROM app.clients WHERE id=$1::uuid`, id).Scan(&value, &count); err != nil || value != urls[i] || count != map[bool]int{true: 1, false: 0}[urls[i] != ""] {
			t.Fatal("legacy data lost", err)
		}
	}
	var review bool
	var raw string
	if err := conn.QueryRow(f.ctx, `SELECT needs_review,url FROM app.client_websites WHERE client_id=$1::uuid`, ids[2]).Scan(&review, &raw); err != nil || !review || raw != urls[2] {
		t.Fatal("malformed legacy URL not preserved", err)
	}
	if _, err := p.DownTo(f.ctx, 25); err != nil {
		t.Fatal("untouched migrated rollback failed", err)
	}
	if _, err := p.Up(f.ctx); err != nil {
		t.Fatal("legacy reapply failed", err)
	}
}

func TestWebsiteConnectionOwnershipBindingAndReadScope(t *testing.T) {
	f := websiteFixture(t)
	ctx := correlation.New(f.base.ctx)
	a, err := f.records.WriteWebsite(ctx, f.actor, clientAID, "", 0, "create", clients.WebsiteProfile{Name: "A", URL: "a.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.records.WriteWebsite(ctx, f.actor, clientAID, "", 0, "create", clients.WebsiteProfile{Name: "B", URL: "b.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	own := "72000000-0000-4000-8000-000000000001"
	foreign := "72000000-0000-4000-8000-000000000002"
	if _, err = f.admin.Exec(ctx, `INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES($1::uuid,$2::uuid,'ga4','42'),($3::uuid,$4::uuid,'ga4','43')`, own, clientAID, foreign, clientBID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.records.BindWebsiteConnection(ctx, f.actor, clientAID, a.ID, foreign, 1, true); !errors.Is(err, clients.ErrMissing) {
		var pe *pgconn.PgError
		if errors.As(err, &pe) {
			t.Fatalf("binding database code=%s message=%s", pe.Code, pe.Message)
		}
		t.Fatal("cross-client connection assigned", err)
	}
	if _, err = f.admin.Exec(ctx, `INSERT INTO app.website_integrations VALUES($1::uuid,$2::uuid,$3::uuid)`, foreign, a.ID, clientAID); err == nil {
		t.Fatal("database ownership foreign key missing")
	}
	viewer := f.user(t, "website.binding.viewer@example.com")
	if _, err = f.authorizer.AssignRole(ctx, f.actor, viewer.ID, authorization.ViewerRoleID, authorization.Client, clientAID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.records.BindWebsiteConnection(ctx, viewer.ID, clientAID, a.ID, own, 1, true); !errors.Is(err, clients.ErrMissing) {
		t.Fatal("reader assigned a connection")
	}
	if _, err = f.records.BindWebsiteConnection(ctx, f.actor, clientAID, a.ID, own, 1, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.records.BindWebsiteConnection(ctx, f.actor, clientAID, b.ID, own, 1, true); !errors.Is(err, clients.ErrConflict) {
		t.Fatal("connection silently moved")
	}
	items, _, err := f.records.WebsiteConnections(ctx, f.actor, clientAID, a.ID, "", 25)
	if err != nil || len(items) != 1 {
		t.Fatal("assigned connections lost", err)
	}
	var metadata map[string]json.RawMessage
	if err = json.Unmarshal(items[0], &metadata); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"created_at", "updated_at"} {
		var value string
		if err = json.Unmarshal(metadata[field], &value); err != nil {
			t.Fatal(err)
		}
		if _, err = time.Parse(time.RFC3339Nano, value); err != nil || !strings.HasSuffix(value, "Z") {
			t.Fatal("connection timestamp does not match the UTC frontend contract", err)
		}
	}
	changes, _, err := f.records.WebsiteActivity(ctx, f.actor, clientAID, a.ID, "", 25)
	if err != nil || len(changes) < 1 {
		t.Fatal("website activity missing", err)
	}
	if err = json.Unmarshal(changes[0], &metadata); err != nil {
		t.Fatal(err)
	}
	var changedAt string
	if err = json.Unmarshal(metadata["occurred_at"], &changedAt); err != nil {
		t.Fatal(err)
	}
	if _, err = time.Parse(time.RFC3339Nano, changedAt); err != nil || !strings.HasSuffix(changedAt, "Z") {
		t.Fatal("activity timestamp does not match the UTC frontend contract", err)
	}
	items, _, err = f.records.WebsiteConnections(ctx, f.actor, clientAID, b.ID, "", 25)
	if err != nil || len(items) != 0 {
		t.Fatal("website metrics mixed", err)
	}
	var allowed bool
	for _, test := range []struct {
		client, website, connection string
		allowed                     bool
	}{{clientAID, a.ID, own, true}, {clientAID, b.ID, own, false}, {clientBID, a.ID, own, false}, {clientAID, a.ID, foreign, false}} {
		if err = f.runtime.QueryRow(ctx, `SELECT app.website_connection_allowed($1::uuid,$2::uuid,$3::uuid,$4::uuid)`, f.actor, test.client, test.website, test.connection).Scan(&allowed); err != nil || allowed != test.allowed {
			t.Fatal("nested provider ownership check failed", err)
		}
	}
	if _, err = f.records.BindWebsiteConnection(ctx, f.actor, clientAID, a.ID, own, 1, false); !errors.Is(err, clients.ErrConflict) {
		t.Fatal("stale binding removed")
	}
	if _, err = f.records.BindWebsiteConnection(ctx, f.actor, clientAID, a.ID, own, 2, false); err != nil {
		t.Fatal(err)
	}
	if _, err = f.records.BindWebsiteConnection(ctx, f.actor, clientAID, b.ID, own, 1, true); err != nil {
		t.Fatal("explicit website reassignment failed", err)
	}
	var state string
	if err = f.admin.QueryRow(ctx, `SELECT state FROM app.integration_connections WHERE id=$1::uuid`, own).Scan(&state); err != nil || state != "pending" {
		t.Fatal("association changed provider lifecycle", err)
	}
	var count int
	if err = f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events WHERE resource_kind='website_integration' AND resource_id=$1::uuid`, own).Scan(&count); err != nil || count != 3 {
		t.Fatal("association audit history incomplete", err)
	}
}

func TestWebsiteHTTPScopesCSRFAndProviderDispatch(t *testing.T) {
	f := websiteFixture(t)
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	auth, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	h, err := clients.NewHandler(f.records, auth, logger)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	downstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/api/v1/clients/"+clientAID+"/analytics/72000000-0000-4000-8000-000000000001/reports" {
			t.Error("provider path changed incorrectly")
		}
		w.WriteHeader(http.StatusNoContent)
	})
	f.handler = httpapi.RequestMiddleware(logger, h.WithWebsiteProviders(downstream))
	base := "clients/" + clientAID + "/websites"
	profile := clients.WebsiteProfile{Name: "Synthetic website", URL: "shop.example.com/catalog"}
	assertStatus(t, f.request(t, nil, "GET", base, nil, nil), 401, "authentication_required")
	assertStatus(t, f.request(t, &f.login, "POST", base, profile, func(r *http.Request) { r.Header.Set("X-CSRF-Token", "wrong") }), 403, "csrf_failed")
	w := f.request(t, &f.login, "POST", base, profile, nil)
	assertStatus(t, w, 201, "")
	var created struct {
		Data clients.Mutation `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.Data.ID == "" {
		t.Fatal("website creation response invalid")
	}
	assertStatus(t, f.request(t, &f.login, "GET", base+"/"+created.Data.ID, nil, nil), 200, "")
	assertStatus(t, f.request(t, &f.login, "GET", base+"?limit=101", nil, nil), 400, "invalid_request")
	assertStatus(t, f.request(t, &f.login, "GET", "clients/"+clientBID+"/websites/"+created.Data.ID, nil, nil), 404, "not_found")
	own := "72000000-0000-4000-8000-000000000001"
	if _, err = f.admin.Exec(f.base.ctx, `INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES($1::uuid,$2::uuid,'ga4','42')`, own, clientAID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.records.BindWebsiteConnection(correlation.New(f.base.ctx), f.actor, clientAID, created.Data.ID, own, 1, true); err != nil {
		t.Fatal(err)
	}
	path := base + "/" + created.Data.ID + "/analytics/" + own + "/reports"
	assertStatus(t, f.request(t, &f.login, "GET", path, nil, nil), 204, "")
	assertStatus(t, f.request(t, &f.login, "POST", path, map[string]any{}, func(r *http.Request) { r.Header.Set("X-CSRF-Token", "wrong") }), 403, "csrf_failed")
	other, err := f.records.WriteWebsite(correlation.New(f.base.ctx), f.actor, clientAID, "", 0, "create", clients.WebsiteProfile{Name: "Other", URL: "other.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &f.login, "GET", base+"/"+other.ID+"/analytics/"+own+"/reports", nil, nil), 404, "not_found")
	if calls != 1 {
		t.Fatal("denied request dispatched to provider")
	}
	if _, err = f.records.WriteWebsite(correlation.New(f.base.ctx), f.actor, clientAID, created.Data.ID, 2, "archive", clients.WebsiteProfile{}); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &f.login, "POST", path, map[string]any{}, nil), 404, "not_found")
	assertStatus(t, f.request(t, &f.login, "GET", path, nil, nil), 204, "")
	if calls != 2 {
		t.Fatal("archived site mutated or stored read lost")
	}
}
