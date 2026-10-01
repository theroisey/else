//go:build integration

package integration

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/database"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
)

const (
	bootstrapEmail    = "initial.admin@example.com"
	bootstrapName     = "Initial Administrator"
	bootstrapPassword = "correct horse battery staple"
)

type identityFixture struct {
	base        *fixture
	admin       *pgx.Conn
	adminPool   *pgxpool.Pool
	runtime     *pgxpool.Pool
	runtimeRole string
	service     *identity.Service
	authorizer  *authorization.Service
}

func newIdentityFixture(t *testing.T) *identityFixture {
	t.Helper()
	f := newFixture(t)
	if _, err := provider(t, f).Up(f.ctx); err != nil {
		t.Fatal(err)
	}
	admin := connection(t, f)
	adminPool, err := database.Open(f.ctx, settings(t, f.URL))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(adminPool.Close)
	role, runtimeURL := f.role(t)
	quoted := pgx.Identifier{role}.Sanitize()
	for _, sql := range []string{
		"GRANT USAGE ON SCHEMA app TO " + quoted,
		"GRANT SELECT (id) ON app.users TO " + quoted,
		"GRANT UPDATE (last_login_at,updated_at) ON app.users TO " + quoted,
		"GRANT SELECT (id,expires_at,revoked_at) ON app.sessions TO " + quoted,
		"GRANT INSERT (id,user_id,token_hash,csrf_hash,created_at,expires_at) ON app.sessions TO " + quoted,
		"GRANT UPDATE (revoked_at) ON app.sessions TO " + quoted,
		"GRANT EXECUTE ON FUNCTION app.authentication_identity(text), app.lock_authentication_identity(uuid), app.current_identity(bytea,timestamptz) TO " + quoted,
		"GRANT EXECUTE ON FUNCTION app.authorization_grants(uuid), app.authorization_allowed(uuid,text,uuid), app.create_role_assignment(uuid,uuid,uuid,text,uuid,uuid,timestamptz), app.revoke_role_assignment(uuid,uuid,timestamptz), app.create_permission_assignment(uuid,uuid,text,uuid,timestamptz), app.revoke_permission_assignment(uuid,uuid,timestamptz) TO " + quoted,
		"GRANT INSERT " + auditColumns + " ON app.audit_events TO " + quoted,
		"GRANT EXECUTE ON FUNCTION app.audit_snapshot_allowed(jsonb) TO " + quoted,
	} {
		if _, err := admin.Exec(f.ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	runtime, err := database.Open(f.ctx, settings(t, runtimeURL))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	authorizer, err := authorization.NewService(runtime)
	if err != nil {
		t.Fatal(err)
	}
	service, err := identity.NewService(runtime, identity.ArgonPasswords{}, authorizer)
	if err != nil {
		t.Fatal(err)
	}
	return &identityFixture{base: f, admin: admin, adminPool: adminPool, runtime: runtime, runtimeRole: quoted, service: service, authorizer: authorizer}
}

func (f *identityFixture) bootstrap(t *testing.T) string {
	t.Helper()
	id, err := identity.Bootstrap(correlation.New(f.base.ctx), f.adminPool, identity.ArgonPasswords{}, bootstrapEmail, bootstrapName, bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestIdentityBootstrapIsOneTimeAuditedAndHistoryPreserving(t *testing.T) {
	f := newIdentityFixture(t)
	id := f.bootstrap(t)
	var email, name, hash, status, event string
	var marker bool
	err := f.admin.QueryRow(f.base.ctx, `SELECT u.email,u.display_name,u.password_hash,u.status,u.bootstrap_admin,a.event_name
		FROM app.users u JOIN app.audit_events a ON a.resource_id=u.id WHERE u.id=$1::uuid`, id).Scan(&email, &name, &hash, &status, &marker, &event)
	if err != nil || email != bootstrapEmail || name != bootstrapName || status != "active" || !marker || event != "user.created" || strings.Contains(hash, bootstrapPassword) || !(identity.ArgonPasswords{}).Verify(hash, bootstrapPassword) {
		t.Fatal("bootstrap identity or audit contract failed")
	}
	var assignments, assignmentEvents int
	if err := f.admin.QueryRow(f.base.ctx, `SELECT
		(SELECT count(*) FROM app.user_roles WHERE user_id=$1::uuid AND role_id=$2::uuid AND scope_kind='global' AND revoked_at IS NULL),
		(SELECT count(*) FROM app.audit_events WHERE event_name='role_assignment.created')`, id, authorization.InitialAdministratorRoleID).Scan(&assignments, &assignmentEvents); err != nil || assignments != 1 || assignmentEvents != 1 {
		t.Fatal("bootstrap administrator role assignment was not atomically audited")
	}
	if _, err := identity.Bootstrap(correlation.New(f.base.ctx), f.adminPool, identity.ArgonPasswords{}, "other@example.com", "Other Admin", bootstrapPassword); !errors.Is(err, identity.ErrAlreadyInitialized) {
		t.Fatal("repeat bootstrap was not refused")
	}
	if _, err := provider(t, f.base).Down(f.base.ctx); err == nil {
		t.Fatal("identity rollback destroyed nonempty data")
	}
	var count int
	if err := f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app.users").Scan(&count); err != nil || count != 1 {
		t.Fatal("refused rollback lost identity")
	}
}

func TestSessionLifecycleUsesHashedTokensAndAtomicAudit(t *testing.T) {
	f := newIdentityFixture(t)
	userID := f.bootstrap(t)
	login, err := f.service.Login(correlation.New(f.base.ctx), " INITIAL.ADMIN@EXAMPLE.COM ", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	if login.Session.User.ID != userID || login.Session.User.Email != bootstrapEmail || login.Token == "" || login.CSRF == "" || len(login.Session.User.Permissions) != 19 {
		t.Fatal("login result missing safe identity/session data")
	}
	var tokenHash, csrfHash []byte
	var rawTokenStored bool
	if err := f.admin.QueryRow(f.base.ctx, "SELECT token_hash,csrf_hash,token_hash::text=$2 FROM app.sessions WHERE id=$1::uuid", login.Session.ID, login.Token).Scan(&tokenHash, &csrfHash, &rawTokenStored); err != nil || len(tokenHash) != 32 || len(csrfHash) != 32 || rawTokenStored {
		t.Fatal("session secrets were not stored as fixed digests")
	}
	current, err := f.service.Current(f.base.ctx, login.Token)
	if err != nil || current.User.ID != userID || len(current.User.Permissions) != 19 {
		t.Fatal("current session lookup failed")
	}
	if !f.service.ValidCSRF(current, login.CSRF, login.CSRF) || f.service.ValidCSRF(current, login.CSRF, "wrong") {
		t.Fatal("session-bound CSRF verification failed")
	}
	if err := f.service.Logout(correlation.New(f.base.ctx), current); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Current(f.base.ctx, login.Token); !errors.Is(err, identity.ErrUnauthorized) {
		t.Fatal("revoked session remained valid")
	}
	var events int
	if err := f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid", login.Session.ID).Scan(&events); err != nil || events != 2 {
		t.Fatal("login/logout audit events missing")
	}
}

func TestAuthenticationFailuresDoNotEnumerateAndAuditFailureRollsBack(t *testing.T) {
	f := newIdentityFixture(t)
	userID := f.bootstrap(t)
	for _, attempt := range []struct{ email, password string }{{bootstrapEmail, "wrong-password-value"}, {"missing@example.com", "wrong-password-value"}} {
		if _, err := f.service.Login(correlation.New(f.base.ctx), attempt.email, attempt.password); !errors.Is(err, identity.ErrInvalidCredentials) {
			t.Fatal("invalid credentials were distinguishable")
		}
	}
	if _, err := f.admin.Exec(f.base.ctx, "UPDATE app.users SET status='disabled' WHERE id=$1::uuid", userID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Login(correlation.New(f.base.ctx), bootstrapEmail, bootstrapPassword); !errors.Is(err, identity.ErrInvalidCredentials) {
		t.Fatal("disabled account authenticated or used a distinct error")
	}
	if _, err := f.admin.Exec(f.base.ctx, "UPDATE app.users SET status='active' WHERE id=$1::uuid", userID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(f.base.ctx, "REVOKE INSERT "+auditColumns+" ON app.audit_events FROM "+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Login(correlation.New(f.base.ctx), bootstrapEmail, bootstrapPassword); err == nil {
		t.Fatal("audit insert failure allowed login")
	}
	var sessions int
	var lastLogin *string
	if err := f.admin.QueryRow(f.base.ctx, "SELECT (SELECT count(*) FROM app.sessions), last_login_at::text FROM app.users WHERE id=$1::uuid", userID).Scan(&sessions, &lastLogin); err != nil || sessions != 0 || lastLogin != nil {
		t.Fatal("audit failure left a partial identity mutation")
	}
}

func TestExpiredAndDisabledSessionsAreUnauthorized(t *testing.T) {
	f := newIdentityFixture(t)
	userID := f.bootstrap(t)
	login, err := f.service.Login(correlation.New(f.base.ctx), bootstrapEmail, bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(f.base.ctx, "UPDATE app.sessions SET expires_at=created_at+interval '1 microsecond' WHERE id=$1::uuid", login.Session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Current(f.base.ctx, login.Token); !errors.Is(err, identity.ErrUnauthorized) {
		t.Fatal("expired session accepted")
	}
	second, err := f.service.Login(correlation.New(f.base.ctx), bootstrapEmail, bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(f.base.ctx, "UPDATE app.users SET status='disabled' WHERE id=$1::uuid", userID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Current(f.base.ctx, second.Token); !errors.Is(err, identity.ErrUnauthorized) {
		t.Fatal("disabled user's session accepted")
	}
}

func TestRuntimeCannotGrantBootstrapOrDeleteIdentityHistory(t *testing.T) {
	f := newIdentityFixture(t)
	f.bootstrap(t)
	for _, sql := range []string{"SELECT email FROM app.users", "SELECT password_hash FROM app.users", "SELECT token_hash FROM app.sessions", "SELECT bootstrap_admin FROM app.users", "UPDATE app.users SET bootstrap_admin=true", "UPDATE app.users SET password_hash='secret'", "DELETE FROM app.users", "DELETE FROM app.sessions", "TRUNCATE app.users CASCADE", "INSERT INTO app.users (email,display_name,password_hash,bootstrap_admin) VALUES ('attacker@example.com','Attacker','secret',true)"} {
		if _, err := f.runtime.Exec(f.base.ctx, sql); err == nil {
			t.Fatalf("runtime identity privilege allowed %s", sql)
		}
	}
}

func TestAuthHTTPContractEnforcesOriginCSRFAndSafeResponses(t *testing.T) {
	f := newIdentityFixture(t)
	f.bootstrap(t)
	authConfig := config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	authHandler, err := identity.NewHandler(f.service, authConfig, logger)
	if err != nil {
		t.Fatal(err)
	}
	handler := httpapi.RequestMiddleware(logger, authHandler)

	loginRequest := func(email, password, origin string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"email": email, "password": password})
		r := httptest.NewRequest(http.MethodPost, "https://else.example/api/v1/auth/login", bytes.NewReader(body))
		r.RemoteAddr = "192.0.2.1:1234"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := loginRequest(bootstrapEmail, bootstrapPassword, "https://evil.example"); w.Code != http.StatusForbidden {
		t.Fatal("cross-origin login accepted")
	}
	wrong := loginRequest(bootstrapEmail, "wrong-password-value", authConfig.PublicOrigin)
	missing := loginRequest("missing@example.com", "wrong-password-value", authConfig.PublicOrigin)
	if errorCode(t, wrong) != errorCode(t, missing) || wrong.Code != http.StatusUnauthorized || missing.Code != http.StatusUnauthorized {
		t.Fatal("HTTP authentication enumerated accounts")
	}
	success := loginRequest(bootstrapEmail, bootstrapPassword, authConfig.PublicOrigin)
	if success.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", success.Code, success.Body.String())
	}
	if !strings.Contains(success.Body.String(), `"permission":"roles.manage"`) || !strings.Contains(success.Body.String(), `"scope":"global"`) {
		t.Fatal("current identity omitted effective permission grants")
	}
	var sessionCookie, csrfCookie *http.Cookie
	for _, cookie := range success.Result().Cookies() {
		if cookie.Name == "__Host-else_session" {
			sessionCookie = cookie
		}
		if cookie.Name == "__Host-else_csrf" {
			csrfCookie = cookie
		}
	}
	if sessionCookie == nil || csrfCookie == nil || !sessionCookie.HttpOnly || csrfCookie.HttpOnly || !sessionCookie.Secure || !csrfCookie.Secure || sessionCookie.SameSite != http.SameSiteStrictMode || sessionCookie.Domain != "" {
		t.Fatal("secure cookie contract failed")
	}
	if strings.Contains(success.Body.String(), sessionCookie.Value) || strings.Contains(success.Body.String(), csrfCookie.Value) || strings.Contains(success.Body.String(), "password") || strings.Contains(success.Body.String(), "bootstrap") {
		t.Fatal("auth response exposed sensitive state")
	}

	current := httptest.NewRequest(http.MethodGet, "https://else.example/api/v1/auth/session", nil)
	current.AddCookie(sessionCookie)
	currentW := httptest.NewRecorder()
	handler.ServeHTTP(currentW, current)
	if currentW.Code != http.StatusOK {
		t.Fatal("current identity failed")
	}
	logout := func(token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "https://else.example/api/v1/auth/logout", strings.NewReader("{}"))
		r.Header.Set("Origin", authConfig.PublicOrigin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF-Token", token)
		r.AddCookie(sessionCookie)
		r.AddCookie(csrfCookie)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := logout("wrong"); w.Code != http.StatusForbidden {
		t.Fatal("invalid CSRF accepted")
	}
	if w := logout(csrfCookie.Value); w.Code != http.StatusNoContent {
		t.Fatalf("logout failed: %d %s", w.Code, w.Body.String())
	}
	currentW = httptest.NewRecorder()
	handler.ServeHTTP(currentW, current)
	if currentW.Code != http.StatusUnauthorized {
		t.Fatal("logout did not revoke HTTP session")
	}
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Error.Code
}
