//go:build integration

package integration

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/clients"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type clientFixture struct {
	*administrationFixture
	records *clients.Service
	logs    *bytes.Buffer
}

func TestClientConcurrentEditsAndAssignmentAfterArchive(t *testing.T) {
	f := newClientFixture(t)
	ctx := correlation.New(f.base.ctx)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, name := range []string{"Concurrent A", "Concurrent B"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			p := profileFixture()
			p.Name = name
			_, err := f.records.Update(ctx, f.actor, clientAID, 1, p)
			results <- err
		}(name)
	}
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, clients.ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatal("concurrent edit lost revision protection")
	}
	var events int
	if err := f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid AND event_name='client.updated'", clientAID).Scan(&events); err != nil || events != 1 {
		t.Fatal("rejected concurrent edit produced an event")
	}
	target := f.user(t, "archive.race@example.com")
	tx, err := f.admin.Begin(f.base.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.base.ctx)
	if _, err := tx.Exec(f.base.ctx, "SELECT pg_advisory_xact_lock(871092650209)"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(f.base.ctx, "UPDATE app.clients SET archived_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1::uuid", clientBID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := f.authorizer.AssignRole(ctx, f.actor, target.ID, authorization.ViewerRoleID, authorization.Client, clientBID)
		result <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var waiting bool
		if err := f.adminPool.QueryRow(f.base.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("assignment did not wait for archive lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Commit(f.base.ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, authorization.ErrDenied) {
		t.Fatal("assignment used a pre-archive snapshot", err)
	}
}

func TestClientCreatorGetsNoImplicitAccess(t *testing.T) {
	f := newClientFixture(t)
	ctx := correlation.New(f.base.ctx)
	user := f.user(t, "create.only@example.com")
	role, err := f.accounts.CreateRole(ctx, f.actor, "Create Only", []authorization.Permission{authorization.ClientsCreate})
	if err != nil {
		t.Fatal(err)
	}
	f.assignment(t, user.ID, role.ID)
	created, err := f.records.Create(ctx, user.ID, profileFixture())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.records.Detail(ctx, user.ID, created.ID); !errors.Is(err, clients.ErrMissing) {
		t.Fatal("creation implicitly granted view access")
	}
	if _, err := f.records.List(ctx, user.ID, clients.Filter{Limit: 25, Status: "active", Sort: "id"}); !errors.Is(err, clients.ErrDenied) {
		t.Fatal("creation implicitly granted list access")
	}
}

func newClientFixture(t *testing.T) *clientFixture {
	t.Helper()
	f := newAdministrationFixture(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION app.client_read(uuid,uuid),app.client_list(uuid,uuid,integer,text,text,text,boolean),app.client_write(uuid,uuid,bigint,jsonb,boolean) TO `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	service, err := clients.NewService(f.runtime)
	if err != nil {
		t.Fatal(err)
	}
	logs := &bytes.Buffer{}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	auth, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := clients.NewHandler(service, auth, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = httpapi.RequestMiddleware(logger, handler)
	return &clientFixture{f, service, logs}
}
func profileFixture() clients.Profile {
	return clients.Profile{Name: "Synthetic Client", LegalName: "Synthetic Legal Name", Website: "https://example.com", Notes: "Synthetic private note", Contacts: []clients.Contact{{Name: "Synthetic Contact", Email: "contact@example.com", Phone: "+1 555 0100"}}, Tags: []string{"priority", "synthetic"}}
}
func TestClientHTTPProfileRevisionArchiveAndSafeAudit(t *testing.T) {
	f := newClientFixture(t)
	ctx := correlation.New(f.base.ctx)
	w := f.request(t, &f.login, "POST", "clients", profileFixture(), nil)
	assertStatus(t, w, 201, "")
	var created struct {
		Data clients.Mutation `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.Data.ID == "" || created.Data.Revision != 1 {
		t.Fatal("create response failed")
	}
	id := created.Data.ID
	p := profileFixture()
	p.Name = "Updated Synthetic Client"
	p.Tags = []string{"revised"}
	p.Contacts = []clients.Contact{{Name: "Replacement Contact", Email: "replacement@example.com"}}
	payload := struct {
		clients.Profile
		Revision int64 `json:"expected_revision"`
	}{p, 1}
	assertStatus(t, f.request(t, &f.login, "PUT", "clients/"+id, payload, nil), 200, "")
	assertStatus(t, f.request(t, &f.login, "PUT", "clients/"+id, payload, nil), 409, "conflict")
	item, err := f.records.Detail(ctx, f.actor, id)
	if err != nil || item.Revision != 2 || item.Name != p.Name || len(item.Contacts) != 1 || item.Contacts[0].Email != "replacement@example.com" || len(item.Tags) != 1 || item.Tags[0] != "revised" {
		t.Fatal("profile replacement/revision failed", err)
	}
	target := f.user(t, "client.viewer@example.com")
	assignment, err := f.authorizer.AssignRole(ctx, f.actor, target.ID, authorization.ViewerRoleID, authorization.Client, id)
	if err != nil {
		t.Fatal(err)
	}
	archive := map[string]any{"expected_revision": 2, "confirm": false}
	assertStatus(t, f.request(t, &f.login, "POST", "clients/"+id+"/archive", archive, nil), 400, "invalid_request")
	archive["confirm"] = true
	assertStatus(t, f.request(t, &f.login, "POST", "clients/"+id+"/archive", archive, nil), 200, "")
	item, err = f.records.Detail(ctx, target.ID, id)
	if err != nil || item.Status != "archived" || item.ArchivedAt == nil || item.Revision != 3 || item.Contacts[0].Email != "replacement@example.com" {
		t.Fatal("archive erased authorized history", err)
	}
	payload.Revision = 3
	assertStatus(t, f.request(t, &f.login, "PUT", "clients/"+id, payload, nil), 409, "conflict")
	archive["expected_revision"] = 3
	assertStatus(t, f.request(t, &f.login, "POST", "clients/"+id+"/archive", archive, nil), 409, "conflict")
	if _, err := f.authorizer.AssignRole(ctx, f.actor, target.ID, authorization.FinanceRoleID, authorization.Client, id); !errors.Is(err, authorization.ErrDenied) {
		t.Fatal("new archived client assignment allowed", err)
	}
	if err := f.authorizer.RevokeRole(ctx, f.actor, assignment); err != nil {
		t.Fatal("archived assignment removal failed", err)
	}
	archivedPage, err := f.records.List(ctx, f.actor, clients.Filter{Limit: 25, Status: "archived", Sort: "id"})
	if err != nil || len(archivedPage.Data) != 1 || archivedPage.Data[0].ID != id {
		t.Fatal("archived list lost historical record", err)
	}
	activePage, err := f.records.List(ctx, f.actor, clients.Filter{Limit: 25, Status: "active", Sort: "id"})
	if err != nil || len(activePage.Data) != 2 {
		t.Fatal("active list included archived client", err)
	}
	var events, unsafe int
	if err := f.admin.QueryRow(f.base.ctx, `SELECT count(*),count(*) FILTER(WHERE client_id<>resource_id OR before_state::text LIKE '%email%' OR after_state::text LIKE '%name%' OR after_state::text LIKE '%Synthetic%') FROM app.audit_events WHERE resource_id=$1::uuid AND resource_kind='client'`, id).Scan(&events, &unsafe); err != nil || events != 3 || unsafe != 0 {
		t.Fatal("safe atomic audit contract failed", err)
	}
	var names string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT string_agg(event_name,',' ORDER BY occurred_at) FROM app.audit_events WHERE resource_id=$1::uuid AND resource_kind='client'`, id).Scan(&names); err != nil || names != "client.created,client.updated,client.archived" {
		t.Fatal("event actions failed", err)
	}
	for _, value := range []string{"contact@example.com", "replacement@example.com", "Synthetic private note"} {
		if strings.Contains(f.logs.String(), value) {
			t.Fatal("profile leaked into logs")
		}
	}
}
func TestClientScopeIsolationEveryLookupAndBoundedList(t *testing.T) {
	f := newClientFixture(t)
	ctx := correlation.New(f.base.ctx)
	viewer := f.user(t, "scoped.viewer@example.com")
	if _, err := f.authorizer.AssignRole(ctx, f.actor, viewer.ID, authorization.ViewerRoleID, authorization.Client, clientAID); err != nil {
		t.Fatal(err)
	}
	login, err := f.service.Login(ctx, "scoped.viewer@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &login, "GET", "clients/"+clientAID, nil, nil), 200, "")
	for _, id := range []string{clientBID, "99999999-9999-4999-8999-999999999999"} {
		assertStatus(t, f.request(t, &login, "GET", "clients/"+id, nil, nil), 404, "not_found")
		assertStatus(t, f.request(t, &login, "PUT", "clients/"+id, map[string]any{"name": "forged", "expected_revision": 1}, nil), 404, "not_found")
		assertStatus(t, f.request(t, &login, "POST", "clients/"+id+"/archive", map[string]any{"expected_revision": 1, "confirm": true}, nil), 404, "not_found")
	}
	assertStatus(t, f.request(t, &login, "PUT", "clients/"+clientAID, map[string]any{"name": "forged", "expected_revision": 1}, nil), 404, "not_found")
	assertStatus(t, f.request(t, &login, "POST", "clients", profileFixture(), nil), 403, "permission_denied")
	w := f.request(t, &login, "GET", "clients?status=all&limit=1", nil, nil)
	assertStatus(t, w, 200, "")
	var page clients.Page
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Data) != 1 || page.Data[0].ID != clientAID || page.Page.NextCursor != nil {
		t.Fatal("list leaked other clients")
	}
	editorRole, err := f.accounts.CreateRole(ctx, f.actor, "Client Editor", []authorization.Permission{authorization.ClientsView, authorization.ClientsUpdate, authorization.ClientsArchive})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.authorizer.AssignRole(ctx, f.actor, viewer.ID, editorRole.ID, authorization.Client, clientAID); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &login, "PUT", "clients/"+clientAID, map[string]any{"name": "Scoped Updated", "expected_revision": 1}, nil), 200, "")
	assertStatus(t, f.request(t, &login, "PUT", "clients/"+clientBID, map[string]any{"name": "forged", "expected_revision": 1}, nil), 404, "not_found")
	w = f.request(t, &f.login, "GET", "clients?limit=1&sort=-id", nil, nil)
	assertStatus(t, w, 200, "")
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Data) != 1 || page.Data[0].ID != clientBID || page.Page.NextCursor == nil {
		t.Fatal("descending cursor failed")
	}
	w = f.request(t, &f.login, "GET", "clients?limit=1&sort=-id&cursor="+*page.Page.NextCursor, nil, nil)
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Data) != 1 || page.Data[0].ID != clientAID || page.Page.NextCursor != nil {
		t.Fatal("second page failed")
	}
	w = f.request(t, &f.login, "GET", "clients?limit=1&sort=id", nil, nil)
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Data) != 1 || page.Data[0].ID != clientAID || page.Page.NextCursor == nil {
		t.Fatal("ascending cursor failed")
	}
	w = f.request(t, &f.login, "GET", "clients?limit=1&sort=id&cursor="+*page.Page.NextCursor, nil, nil)
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Data) != 1 || page.Data[0].ID != clientBID || page.Page.NextCursor != nil {
		t.Fatal("ascending second page failed")
	}
	created, err := f.records.Create(ctx, f.actor, profileFixture())
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"q=Synthetic%20Client&tag=priority", "q=%25", "tag=missing", "status=archived"} {
		w = f.request(t, &f.login, "GET", "clients?"+query, nil, nil)
		assertStatus(t, w, 200, "")
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		want := 0
		if strings.HasPrefix(query, "q=Synthetic") {
			want = 1
		}
		if len(page.Data) != want || (want == 1 && page.Data[0].ID != created.ID) {
			t.Fatal("literal name/tag/status filter failed")
		}
	}
	unassigned := f.user(t, "unassigned.client@example.com")
	noAccess, err := f.service.Login(ctx, "unassigned.client@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &noAccess, "GET", "clients", nil, nil), 403, "permission_denied")
	if _, err := f.authorizer.AssignRole(ctx, f.actor, unassigned.ID, authorization.ViewerRoleID, authorization.Client, "99999999-9999-4999-8999-999999999999"); !errors.Is(err, authorization.ErrDenied) {
		t.Fatal("unknown scope assignment allowed", err)
	}
	assertStatus(t, f.request(t, &login, "POST", "clients/"+clientAID+"/archive", map[string]any{"expected_revision": 2, "confirm": true}, nil), 200, "")
	assertStatus(t, f.request(t, &login, "POST", "clients/"+clientBID+"/archive", map[string]any{"expected_revision": 1, "confirm": true}, nil), 404, "not_found")
}
func TestClientAuditFailureRollsBackEveryMutationAndStorageIsPrivate(t *testing.T) {
	f := newClientFixture(t)
	ctx := correlation.New(f.base.ctx)
	for _, sql := range []string{"SELECT * FROM app.clients", "SELECT * FROM app.client_contacts", "SELECT * FROM app.client_tags", "SELECT * FROM app.client_scopes", "SELECT app.client_document('" + clientAID + "',true)", "UPDATE app.clients SET name='forged'", "DELETE FROM app.clients", "TRUNCATE app.clients"} {
		if _, err := f.runtime.Exec(f.base.ctx, sql); err == nil {
			t.Fatal("runtime bypassed client storage")
		}
	}
	if _, err := f.admin.Exec(f.base.ctx, "REVOKE INSERT "+auditColumns+" ON app.audit_events FROM "+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	if _, err := f.records.Create(ctx, f.actor, profileFixture()); err == nil {
		t.Fatal("unaudited create succeeded")
	}
	if _, err := f.records.Update(ctx, f.actor, clientAID, 1, profileFixture()); err == nil {
		t.Fatal("unaudited update succeeded")
	}
	if _, err := f.records.Archive(ctx, f.actor, clientAID, 1); err == nil {
		t.Fatal("unaudited archive succeeded")
	}
	var count, children, revision int
	var name string
	var archived bool
	if err := f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.clients),(SELECT count(*) FROM app.client_contacts),revision,name,archived_at IS NOT NULL FROM app.clients WHERE id=$1::uuid`, clientAID).Scan(&count, &children, &revision, &name, &archived); err != nil || count != 2 || children != 0 || revision != 1 || name != "Synthetic Scope A" || archived {
		t.Fatal("failed audit retained profile changes", err)
	}
	var scopes int
	if err := f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app.client_scopes").Scan(&scopes); err != nil || scopes != 2 {
		t.Fatal("failed create left scope behind")
	}
}
func TestClientHTTPAuthenticationCSRFAndStrictValidation(t *testing.T) {
	f := newClientFixture(t)
	assertStatus(t, f.request(t, nil, "GET", "clients", nil, nil), 401, "authentication_required")
	for _, alter := range []func(*http.Request){func(r *http.Request) { r.Header.Set("Origin", "https://other.example") }, func(r *http.Request) { r.Header.Del("X-CSRF-Token") }, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }} {
		w := f.request(t, &f.login, "POST", "clients", profileFixture(), alter)
		if w.Code != 403 && w.Code != 415 {
			t.Fatal("browser mutation boundary bypassed")
		}
	}
	for _, input := range []any{map[string]any{"name": "bad\nname"}, map[string]any{"name": "Synthetic", "actor_id": f.actor}, map[string]any{"name": "Synthetic", "contacts": []any{map[string]any{"name": "ok", "token": "forged"}}}} {
		assertStatus(t, f.request(t, &f.login, "POST", "clients", input, nil), 400, "invalid_request")
	}
	for _, query := range []string{"limit=101", "limit=1&limit=2", "cursor=bad", "status=deleted", "sort=unsafe", "q=" + strings.Repeat("x", 101)} {
		assertStatus(t, f.request(t, &f.login, "GET", "clients?"+query, nil, nil), 400, "invalid_request")
	}
	assertStatus(t, f.request(t, &f.login, "DELETE", "clients/"+clientAID, nil, nil), 405, "method_not_allowed")
}
func TestClientMigrationPreservesLegacyScopesAndRefusesPopulatedRollback(t *testing.T) {
	f := newFixture(t)
	p := provider(t, f)
	if _, err := p.UpTo(f.ctx, 5); err != nil {
		t.Fatal(err)
	}
	c := connection(t, f)
	hash, err := (identity.ArgonPasswords{}).Hash(bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Exec(f.ctx, `INSERT INTO app.users(id,email,display_name,password_hash) VALUES($1::uuid,'legacy.scope@example.com','Synthetic Legacy',$2)`, viewerUserID, hash); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Exec(f.ctx, `INSERT INTO app.user_roles(id,user_id,role_id,scope_kind,client_id) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,'client',$3::uuid)`, viewerUserID, authorization.ViewerRoleID, clientAID); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Up(f.ctx); err != nil {
		t.Fatal(err)
	}
	var scopes, records, assignments int
	if err := c.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM app.client_scopes),(SELECT count(*) FROM app.clients),(SELECT count(*) FROM app.user_roles WHERE client_id=$1::uuid)`, clientAID).Scan(&scopes, &records, &assignments); err != nil || scopes != 1 || records != 0 || assignments != 1 {
		t.Fatal("upgrade fabricated records or lost history", err)
	}
	if _, err := c.Exec(f.ctx, `INSERT INTO app.user_roles(id,user_id,role_id,scope_kind,client_id) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,'client',$3::uuid)`, viewerUserID, authorization.FinanceRoleID, clientAID); err == nil {
		t.Fatal("legacy scope accepted a new assignment")
	}
	if _, err := p.DownTo(f.ctx, 8); err != nil {
		t.Fatal("later-domain rollback failed", err)
	}
	if _, err := p.Down(f.ctx); err != nil {
		t.Fatal("empty planning rollback failed", err)
	}
	if _, err := p.Down(f.ctx); err != nil {
		t.Fatal("empty task rollback failed", err)
	}
	if _, err := p.Down(f.ctx); err != nil {
		t.Fatal("scope-only rollback failed", err)
	}
	if _, err := p.Up(f.ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Exec(f.ctx, `INSERT INTO app.clients(id,name) VALUES($1::uuid,'Synthetic Imported Client')`, clientAID); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DownTo(f.ctx, 8); err != nil {
		t.Fatal("later-domain rollback failed", err)
	}
	if _, err := p.Down(f.ctx); err != nil {
		t.Fatal("empty planning rollback failed", err)
	}
	if _, err := p.Down(f.ctx); err != nil {
		t.Fatal("empty task rollback failed", err)
	}
	if _, err := p.Down(f.ctx); err == nil {
		t.Fatal("populated client rollback erased history")
	}
	if err := c.QueryRow(f.ctx, "SELECT count(*) FROM app.clients").Scan(&records); err != nil || records != 1 {
		t.Fatal("refused rollback lost client")
	}
}
