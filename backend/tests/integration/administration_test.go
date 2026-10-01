//go:build integration

package integration

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/theroisey/else/backend/internal/administration"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
)

type administrationFixture struct {
	*identityFixture
	accounts *administration.Service
	handler  http.Handler
	actor    string
	login    identity.LoginResult
}

func newAdministrationFixture(t *testing.T) *administrationFixture {
	t.Helper()
	f := newIdentityFixture(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION
		app.admin_users(uuid,uuid,integer),app.admin_user(uuid,uuid),app.admin_roles(uuid,uuid,integer),app.admin_role(uuid,uuid),
		app.admin_catalog(uuid),app.admin_assignments(uuid,uuid,uuid,integer),
		app.admin_create_user(uuid,uuid,text,text,text),app.admin_update_user(uuid,uuid,bigint,text,text),
		app.admin_disable_user(uuid,uuid,bigint),app.admin_create_role(uuid,uuid,text,text[]),
		app.admin_replace_permissions(uuid,uuid,bigint,text[]),app.admin_revoke_assignment(uuid,uuid,uuid,timestamptz)
		TO `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	accounts, err := administration.NewService(f.runtime, identity.ArgonPasswords{})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	auth, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := administration.NewHandler(accounts, auth, f.authorizer, logger)
	if err != nil {
		t.Fatal(err)
	}
	actor := f.bootstrap(t)
	login, err := f.service.Login(correlation.New(f.base.ctx), bootstrapEmail, bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	return &administrationFixture{f, accounts, httpapi.RequestMiddleware(logger, admin), actor, login}
}

func (f *administrationFixture) request(t *testing.T, login *identity.LoginResult, method, path string, body any, alter func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, "https://else.example/api/v1/"+path, bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://else.example")
	if login != nil {
		r.AddCookie(&http.Cookie{Name: "__Host-else_session", Value: login.Token})
		r.AddCookie(&http.Cookie{Name: "__Host-else_csrf", Value: login.CSRF})
		r.Header.Set("X-CSRF-Token", login.CSRF)
	}
	if alter != nil {
		alter(r)
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return w
}

func (f *administrationFixture) user(t *testing.T, email string) administration.Mutation {
	t.Helper()
	result, err := f.accounts.CreateUser(correlation.New(f.base.ctx), f.actor, email, "Synthetic User", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *administrationFixture) assignment(t *testing.T, user, role string) string {
	t.Helper()
	id, err := f.authorizer.AssignRole(correlation.New(f.base.ctx), f.actor, user, role, authorization.Global, "")
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func assertStatus(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("HTTP status %d, want %d", w.Code, status)
	}
	if code != "" && errorCode(t, w) != code {
		t.Fatalf("unexpected error code: want %s", code)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("administration response can be cached")
	}
}

func TestAdministrationHTTPPaginationValidationAndRevisionConflicts(t *testing.T) {
	f := newAdministrationFixture(t)
	input := map[string]any{"email": " FIRST@EXAMPLE.COM ", "display_name": " First User ", "password": bootstrapPassword}
	w := f.request(t, &f.login, http.MethodPost, "users", input, nil)
	assertStatus(t, w, http.StatusCreated, "")
	var created struct {
		Data administration.Mutation `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.Data.Revision != 1 || created.Data.ID == "" {
		t.Fatal("create response contract failed")
	}
	f.user(t, "second@example.com")
	seen := map[string]bool{}
	cursor := ""
	for pages := 0; ; pages++ {
		if pages > 3 {
			t.Fatal("pagination did not terminate")
		}
		path := "users?limit=1"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		w = f.request(t, &f.login, http.MethodGet, path, nil, nil)
		assertStatus(t, w, http.StatusOK, "")
		var page administration.Page[administration.User]
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Data) != 1 || page.Page.Limit != 1 {
			t.Fatal("bounded page contract failed")
		}
		if seen[page.Data[0].ID] {
			t.Fatal("pagination repeated a user")
		}
		seen[page.Data[0].ID] = true
		for _, forbidden := range []string{"password", "bootstrap", "token_hash", f.login.Token, f.login.CSRF} {
			if strings.Contains(w.Body.String(), forbidden) {
				t.Fatal("user response exposed credential state")
			}
		}
		if page.Page.NextCursor == nil {
			break
		}
		cursor = *page.Page.NextCursor
	}
	if len(seen) != 3 {
		t.Fatal("pagination lost users")
	}
	for _, path := range []string{"users?limit=0", "users?limit=101", "users?cursor=secret", "users?limit=1&limit=2", "users?unknown=1", "users?cursor="} {
		assertStatus(t, f.request(t, &f.login, http.MethodGet, path, nil, nil), http.StatusBadRequest, "invalid_request")
	}
	assertStatus(t, f.request(t, &f.login, http.MethodPost, "users", input, nil), http.StatusConflict, "conflict")
	input["actor_id"] = f.actor
	assertStatus(t, f.request(t, &f.login, http.MethodPost, "users", input, nil), http.StatusBadRequest, "invalid_request")
	patch := map[string]any{"email": "changed@example.com", "display_name": "Changed User", "expected_revision": 1}
	assertStatus(t, f.request(t, &f.login, http.MethodPatch, "users/"+created.Data.ID, patch, nil), http.StatusOK, "")
	assertStatus(t, f.request(t, &f.login, http.MethodPatch, "users/"+created.Data.ID, patch, nil), http.StatusConflict, "conflict")
	assertStatus(t, f.request(t, &f.login, http.MethodPost, "users/"+f.actor+"/disable", map[string]any{"expected_revision": 1, "confirm": true}, nil), http.StatusConflict, "self_disable")
	assertStatus(t, f.request(t, &f.login, http.MethodPost, "users/"+created.Data.ID+"/disable", map[string]any{"expected_revision": 2}, nil), http.StatusBadRequest, "invalid_request")
}

func TestAdministrationPermissionDenialOriginCSRFAndDelegation(t *testing.T) {
	f := newAdministrationFixture(t)
	viewer := f.user(t, "viewer@example.com")
	f.assignment(t, viewer.ID, authorization.ViewerRoleID)
	login, err := f.service.Login(correlation.New(f.base.ctx), "viewer@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"users", "users/" + f.actor, "roles", "roles/" + authorization.ViewerRoleID, "permissions", "users/" + f.actor + "/roles"} {
		assertStatus(t, f.request(t, &login, http.MethodGet, path, nil, nil), http.StatusForbidden, "permission_denied")
		assertStatus(t, f.request(t, nil, http.MethodGet, path, nil, nil), http.StatusUnauthorized, "authentication_required")
	}
	for _, path := range []string{"users", "roles", "users/" + viewer.ID + "/roles", "users/" + viewer.ID + "/disable"} {
		assertStatus(t, f.request(t, &login, http.MethodPost, path, map[string]any{}, nil), http.StatusForbidden, "permission_denied")
	}
	for _, attempt := range []struct{ method, path string }{
		{http.MethodPatch, "users/" + viewer.ID},
		{http.MethodPut, "roles/" + authorization.ViewerRoleID + "/permissions"},
		{http.MethodDelete, "users/" + viewer.ID + "/roles/" + managerRoleID},
	} {
		assertStatus(t, f.request(t, &login, attempt.method, attempt.path, map[string]any{}, nil), http.StatusForbidden, "permission_denied")
	}
	for _, alter := range []func(*http.Request){func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, func(r *http.Request) { r.Header.Del("Origin") }, func(r *http.Request) { r.Header.Set("X-CSRF-Token", "wrong") }, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }} {
		w := f.request(t, &f.login, http.MethodPost, "roles", map[string]any{}, alter)
		if w.Code != http.StatusForbidden && w.Code != http.StatusUnsupportedMediaType {
			t.Fatal("mutation browser boundary was bypassed")
		}
	}
	// Readers recheck their actor even without the HTTP permission gate.
	for _, sql := range []string{"SELECT app.admin_users($1::uuid,NULL,1)", "SELECT app.admin_user($1::uuid,$1::uuid)", "SELECT app.admin_roles($1::uuid,NULL,1)", "SELECT app.admin_role($1::uuid,$1::uuid)", "SELECT app.admin_catalog($1::uuid)", "SELECT app.admin_assignments($1::uuid,$1::uuid,NULL,1)"} {
		if _, err := f.runtime.Exec(f.base.ctx, sql, viewer.ID); err == nil {
			t.Fatal("definer read bypassed live view permissions")
		}
	}
	ctx := correlation.New(f.base.ctx)
	role, err := f.accounts.CreateRole(ctx, f.actor, "Limited role manager", []authorization.Permission{authorization.RolesManage, authorization.RolesView})
	if err != nil {
		t.Fatal(err)
	}
	f.assignment(t, viewer.ID, role.ID)
	assertStatus(t, f.request(t, &login, http.MethodPost, "roles", map[string]any{"display_name": "Escalation", "permissions": []string{"users.manage"}}, nil), http.StatusForbidden, "permission_denied")
	assertStatus(t, f.request(t, &login, http.MethodPut, "roles/"+role.ID+"/permissions", map[string]any{"expected_revision": 1, "confirm": true, "permissions": []string{"users.manage"}}, nil), http.StatusForbidden, "permission_denied")
	assertStatus(t, f.request(t, &login, http.MethodPost, "users/"+viewer.ID+"/roles", map[string]any{"role_id": authorization.InitialAdministratorRoleID, "scope": "global", "confirm": true}, nil), http.StatusForbidden, "permission_denied")
	for _, keys := range [][]string{{"unknown.permission"}, {"users.view", "users.view"}, {}} {
		assertStatus(t, f.request(t, &f.login, http.MethodPost, "roles", map[string]any{"display_name": "Invalid role", "permissions": keys}, nil), http.StatusBadRequest, "invalid_request")
	}
	assertStatus(t, f.request(t, &f.login, http.MethodPut, "roles/"+authorization.InitialAdministratorRoleID+"/permissions", map[string]any{"expected_revision": 1, "confirm": true, "permissions": []string{"users.view"}}, nil), http.StatusConflict, "system_role")
	if _, err := f.accounts.CreateUser(ctx, viewer.ID, "denied@example.com", "Denied", bootstrapPassword); !errors.Is(err, administration.ErrDenied) {
		t.Fatal("database write bypassed live users.manage")
	}
	// A delegated manager may control a capability at one client only. That
	// permits assignment there, but cannot authorize a global role definition.
	manager := f.user(t, "scoped.manager@example.com")
	f.assignment(t, manager.ID, role.ID)
	if _, err := f.authorizer.AssignRole(ctx, f.actor, manager.ID, authorization.ViewerRoleID, authorization.Client, clientAID); err != nil {
		t.Fatal(err)
	}
	scopedLogin, err := f.service.Login(ctx, "scoped.manager@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &scopedLogin, http.MethodPost, "roles", map[string]any{"display_name": "Global escalation", "permissions": []string{"clients.view"}}, nil), http.StatusForbidden, "permission_denied")
	clientViewer, err := f.accounts.CreateRole(ctx, f.actor, "Client viewer", []authorization.Permission{authorization.ClientsView})
	if err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"role_id": clientViewer.ID, "scope": "client", "client_id": clientBID, "confirm": true}
	assertStatus(t, f.request(t, &scopedLogin, http.MethodPost, "users/"+viewer.ID+"/roles", input, nil), http.StatusForbidden, "permission_denied")
	input["client_id"] = clientAID
	assertStatus(t, f.request(t, &scopedLogin, http.MethodPost, "users/"+viewer.ID+"/roles", input, nil), http.StatusCreated, "")
}

func TestAdministrationDisableRevokesEverySessionAndAuditFailureRollsBack(t *testing.T) {
	f := newAdministrationFixture(t)
	target := f.user(t, "target@example.com")
	assignment := f.assignment(t, target.ID, authorization.ViewerRoleID)
	first, err := f.service.Login(correlation.New(f.base.ctx), "target@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.service.Login(correlation.New(f.base.ctx), "target@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	role, err := f.accounts.CreateRole(correlation.New(f.base.ctx), f.actor, "Rollback role", []authorization.Permission{authorization.UsersView})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(f.base.ctx, "REVOKE INSERT "+auditColumns+" ON app.audit_events FROM "+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	ctx := correlation.New(f.base.ctx)
	for name, mutate := range map[string]func() error{
		"create user": func() error {
			_, e := f.accounts.CreateUser(ctx, f.actor, "rollback@example.com", "Rollback", bootstrapPassword)
			return e
		},
		"update user": func() error {
			_, e := f.accounts.UpdateUser(ctx, f.actor, target.ID, 1, "partial@example.com", "Partial")
			return e
		},
		"disable user": func() error { _, e := f.accounts.DisableUser(ctx, f.actor, target.ID, 1); return e },
		"create role": func() error {
			_, e := f.accounts.CreateRole(ctx, f.actor, "Partial role", []authorization.Permission{authorization.UsersView})
			return e
		},
		"replace permissions": func() error {
			_, e := f.accounts.ReplacePermissions(ctx, f.actor, role.ID, 1, []authorization.Permission{authorization.RolesView})
			return e
		},
		"revoke assignment": func() error { return f.accounts.RevokeAssignment(ctx, f.actor, target.ID, assignment) },
	} {
		if mutate() == nil {
			t.Fatalf("audit failure allowed %s", name)
		}
	}
	user, err := f.accounts.User(f.base.ctx, f.actor, target.ID)
	if err != nil || user.Status != "active" || user.Revision != 1 || user.Email != "target@example.com" {
		t.Fatal("audit failure left partial account state")
	}
	r, err := f.accounts.Role(f.base.ctx, f.actor, role.ID)
	if err != nil || r.Revision != 1 || len(r.Permissions) != 1 || r.Permissions[0] != authorization.UsersView {
		t.Fatal("audit failure left partial role state")
	}
	var partial int
	if err := f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.users WHERE email='rollback@example.com')+
		(SELECT count(*) FROM app.roles WHERE display_name='Partial role')+
		(SELECT count(*) FROM app.user_roles WHERE id=$1::uuid AND revoked_at IS NOT NULL)`, assignment).Scan(&partial); err != nil || partial != 0 {
		t.Fatal("audit failure left partial creations or revocation")
	}
	for _, login := range []identity.LoginResult{first, second} {
		if _, err := f.service.Current(f.base.ctx, login.Token); err != nil {
			t.Fatal("audit failure revoked a session")
		}
	}
	if _, err := f.admin.Exec(f.base.ctx, "GRANT INSERT "+auditColumns+" ON app.audit_events TO "+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &f.login, http.MethodPost, "users/"+target.ID+"/disable", map[string]any{"confirm": true, "expected_revision": 1}, nil), http.StatusOK, "")
	for _, login := range []identity.LoginResult{first, second} {
		if _, err := f.service.Current(f.base.ctx, login.Token); !errors.Is(err, identity.ErrUnauthorized) {
			t.Fatal("disabled user's session survived")
		}
	}
	var revoked, events int
	var before, after string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.sessions WHERE user_id=$1::uuid AND revoked_at IS NOT NULL),
		(SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid AND event_name='user.disabled')`, target.ID).Scan(&revoked, &events); err != nil || revoked != 2 || events != 1 {
		t.Fatal("disablement and session revocation were not atomic")
	}
	if err := f.admin.QueryRow(f.base.ctx, `SELECT before_state::text,after_state::text FROM app.audit_events WHERE resource_id=$1::uuid AND event_name='user.disabled'`, target.ID).Scan(&before, &after); err != nil || !strings.Contains(before, `"active"`) || !strings.Contains(after, `"disabled"`) || strings.Contains(before+after, "@") || strings.Contains(before+after, "password") {
		t.Fatal("unsafe or missing audit markers")
	}
}

func TestAdministrationRoleHTTPContractAndScopedAssignments(t *testing.T) {
	f := newAdministrationFixture(t)
	target := f.user(t, "scoped.user@example.com")
	w := f.request(t, &f.login, http.MethodPost, "roles", map[string]any{"display_name": "Custom client viewer", "permissions": []string{"clients.view"}}, nil)
	assertStatus(t, w, http.StatusCreated, "")
	var result struct {
		Data administration.Mutation `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	roleID := result.Data.ID
	for _, path := range []string{"roles?limit=2", "roles/" + roleID, "permissions", "users/" + target.ID} {
		assertStatus(t, f.request(t, &f.login, http.MethodGet, path, nil, nil), http.StatusOK, "")
	}
	input := map[string]any{"role_id": roleID, "scope": "client", "client_id": clientAID, "confirm": true}
	input["role_id"] = strings.ReplaceAll(roleID, "-", "")
	assertStatus(t, f.request(t, &f.login, http.MethodPost, "users/"+target.ID+"/roles", input, nil), http.StatusBadRequest, "invalid_request")
	input["role_id"] = roleID
	input["client_id"] = strings.ReplaceAll(clientAID, "-", "")
	assertStatus(t, f.request(t, &f.login, http.MethodPost, "users/"+target.ID+"/roles", input, nil), http.StatusBadRequest, "invalid_request")
	input["client_id"] = clientAID
	w = f.request(t, &f.login, http.MethodPost, "users/"+target.ID+"/roles", input, nil)
	assertStatus(t, w, http.StatusCreated, "")
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Data.ID == "" {
		t.Fatal("role assignment response failed")
	}
	assignmentID := result.Data.ID
	allowed, err := f.authorizer.Allowed(f.base.ctx, target.ID, authorization.ClientsView, clientAID)
	if err != nil || !allowed {
		t.Fatal("client grant was not effective")
	}
	allowed, err = f.authorizer.Allowed(f.base.ctx, target.ID, authorization.ClientsView, clientBID)
	if err != nil || allowed {
		t.Fatal("client assignment leaked across scope")
	}
	w = f.request(t, &f.login, http.MethodGet, "users/"+target.ID+"/roles?limit=1", nil, nil)
	assertStatus(t, w, http.StatusOK, "")
	var assignments administration.Page[administration.Assignment]
	if err := json.Unmarshal(w.Body.Bytes(), &assignments); err != nil || len(assignments.Data) != 1 || assignments.Data[0].ClientID == nil || *assignments.Data[0].ClientID != clientAID {
		t.Fatal("scoped assignment response failed")
	}
	input = map[string]any{"permissions": []string{"clients.view", "tasks.view"}, "expected_revision": 1, "confirm": true}
	assertStatus(t, f.request(t, &f.login, http.MethodPut, "roles/"+roleID+"/permissions", input, nil), http.StatusOK, "")
	assertStatus(t, f.request(t, &f.login, http.MethodPut, "roles/"+roleID+"/permissions", input, nil), http.StatusConflict, "conflict")
	allowed, err = f.authorizer.Allowed(f.base.ctx, target.ID, authorization.TasksView, clientAID)
	if err != nil || !allowed {
		t.Fatal("role edit did not update current holders")
	}
	assertStatus(t, f.request(t, &f.login, http.MethodDelete, "users/"+f.actor+"/roles/"+assignmentID, map[string]any{"confirm": true}, nil), http.StatusForbidden, "permission_denied")
	assertStatus(t, f.request(t, &f.login, http.MethodDelete, "users/"+target.ID+"/roles/"+assignmentID, map[string]any{"confirm": true}, nil), http.StatusNoContent, "")
	allowed, err = f.authorizer.Allowed(f.base.ctx, target.ID, authorization.ClientsView, clientAID)
	if err != nil || allowed {
		t.Fatal("revoked role remained effective")
	}
	var changed int
	if err := f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid AND event_name='role.permission_changed' AND before_state->>'revision'='1' AND after_state->>'revision'='2'", roleID).Scan(&changed); err != nil || changed != 1 {
		t.Fatal("role permission change was not audited exactly once")
	}
}

func TestConcurrentAdministratorRemovalPreservesRecovery(t *testing.T) {
	f := newAdministrationFixture(t)
	second := f.user(t, "second.admin@example.com")
	secondAssignment := f.assignment(t, second.ID, authorization.InitialAdministratorRoleID)
	firstAssignments, err := f.accounts.Assignments(f.base.ctx, f.actor, f.actor, "", 25)
	if err != nil || len(firstAssignments.Data) != 1 {
		t.Fatal("bootstrap assignment missing")
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, attempt := range []struct{ actor, assignment string }{{f.actor, firstAssignments.Data[0].ID}, {second.ID, secondAssignment}} {
		go func(actor, assignment string) {
			<-start
			results <- f.accounts.RevokeAssignment(correlation.New(f.base.ctx), actor, actor, assignment)
		}(attempt.actor, attempt.assignment)
	}
	close(start)
	a, b := <-results, <-results
	if !((a == nil && errors.Is(b, administration.ErrLastAdministrator)) || (b == nil && errors.Is(a, administration.ErrLastAdministrator))) {
		t.Fatalf("concurrent removals failed recovery policy: %v; %v", a, b)
	}
	var active, archived int
	if err := f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.user_roles WHERE role_id=$1::uuid AND revoked_at IS NULL),
		(SELECT count(*) FROM app.audit_events WHERE event_name='role_assignment.archived')`, authorization.InitialAdministratorRoleID).Scan(&active, &archived); err != nil || active != 1 || archived != 1 {
		t.Fatal("concurrent removals lost recovery or emitted a rejected audit")
	}
}

func TestLastAdministratorGuardCoversDisablementRoleChangesAndLegacyMutators(t *testing.T) {
	f := newAdministrationFixture(t)
	ctx := correlation.New(f.base.ctx)
	manager := f.user(t, "users.manager@example.com")
	limited, err := f.accounts.CreateRole(ctx, f.actor, "Account manager", []authorization.Permission{authorization.UsersManage})
	if err != nil {
		t.Fatal(err)
	}
	f.assignment(t, manager.ID, limited.ID)
	if _, err := f.accounts.DisableUser(ctx, manager.ID, f.actor, 1); !errors.Is(err, administration.ErrLastAdministrator) {
		t.Fatal("account manager disabled final administrator")
	}
	recovery, err := f.accounts.CreateRole(ctx, f.actor, "Custom recovery", []authorization.Permission{authorization.UsersManage, authorization.RolesManage})
	if err != nil {
		t.Fatal(err)
	}
	f.assignment(t, f.actor, recovery.ID)
	assignments, err := f.accounts.Assignments(f.base.ctx, f.actor, f.actor, "", 25)
	if err != nil {
		t.Fatal(err)
	}
	for _, assignment := range assignments.Data {
		if assignment.RoleID == authorization.InitialAdministratorRoleID {
			if err := f.accounts.RevokeAssignment(ctx, f.actor, f.actor, assignment.ID); err != nil {
				t.Fatal("capability-based custom recovery was not recognized", err)
			}
		}
	}
	if _, err := f.accounts.ReplacePermissions(ctx, f.actor, recovery.ID, 1, []authorization.Permission{authorization.RolesManage}); !errors.Is(err, administration.ErrLastAdministrator) {
		t.Fatal("role edit removed final recovery capability")
	}
	var permissionID string
	if err := f.admin.QueryRow(f.base.ctx, "SELECT id::text FROM app.role_permissions WHERE role_id=$1::uuid AND permission_key='users.manage' AND revoked_at IS NULL", recovery.ID).Scan(&permissionID); err != nil {
		t.Fatal(err)
	}
	var failure *pgconn.PgError
	if err := f.authorizer.RevokePermission(ctx, f.actor, permissionID); !errors.As(err, &failure) || failure.Code != "P1001" {
		t.Fatal("legacy permission mutator bypassed final administrator guard")
	}
	var revision int64
	var changed int
	if err := f.admin.QueryRow(f.base.ctx, `SELECT revision,(SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid AND event_name='role.permission_changed') FROM app.roles WHERE id=$1::uuid`, recovery.ID).Scan(&revision, &changed); err != nil || revision != 1 || changed != 0 {
		t.Fatal("rejected role edit changed revision or audit")
	}
	// Runtime has only narrow contracts; trigger helpers and direct row access stay private.
	for _, sql := range []string{"SELECT app.admin_survives(NULL,NULL,NULL)", "SELECT email,password_hash FROM app.users", "UPDATE app.users SET status='disabled'", "UPDATE app.roles SET revision=2", "SELECT * FROM app.role_permissions"} {
		if _, err := f.runtime.Exec(f.base.ctx, sql); err == nil {
			t.Fatal(fmt.Sprintf("runtime bypassed storage boundary: %s", sql))
		}
	}
}

func TestAdministrationMigrationPreservesPopulatedIdentityAndAuthorization(t *testing.T) {
	f := newIdentityFixture(t)
	p := provider(t, f.base)
	if _, err := p.Down(f.base.ctx); err != nil {
		t.Fatal("empty administration rollback failed", err)
	}
	user := f.bootstrap(t)
	login, err := f.service.Login(correlation.New(f.base.ctx), bootstrapEmail, bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Up(f.base.ctx); err != nil {
		t.Fatal("administration upgrade failed", err)
	}
	var revision int64
	var users, assignments, events int
	if err := f.admin.QueryRow(f.base.ctx, `SELECT revision,(SELECT count(*) FROM app.users),
		(SELECT count(*) FROM app.user_roles WHERE user_id=$1::uuid AND revoked_at IS NULL),
		(SELECT count(*) FROM app.audit_events) FROM app.users WHERE id=$1::uuid`, user).Scan(&revision, &users, &assignments, &events); err != nil || revision != 1 || users != 1 || assignments != 1 || events != 3 {
		t.Fatal("upgrade changed existing identity or security history")
	}
	if _, err := f.service.Current(f.base.ctx, login.Token); err != nil {
		t.Fatal("upgrade invalidated an existing session")
	}
	if _, err := p.Down(f.base.ctx); err == nil {
		t.Fatal("populated administration rollback was allowed")
	}
	if err := f.admin.QueryRow(f.base.ctx, "SELECT revision FROM app.users WHERE id=$1::uuid", user).Scan(&revision); err != nil || revision != 1 {
		t.Fatal("refused rollback lost revision data")
	}
}
