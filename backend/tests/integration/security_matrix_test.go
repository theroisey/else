//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/identity"
)

// This exercises compiled production wiring, not a handler assembled by the
// test. Domain suites retain deeper body/resource/concurrency coverage.
func TestSecurityCompiledAPIDenialMatrix(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "api")
	buildContext, stopBuild := context.WithTimeout(context.Background(), 2*time.Minute)
	defer stopBuild()
	build := exec.CommandContext(buildContext, "sh", "scripts/build-api.sh", binary, "", "", "")
	build.Dir = "../.."
	build.Env = append(os.Environ(), "PATH="+filepath.Join(runtime.GOROOT(), "bin")+":"+os.Getenv("PATH"), "CGO_ENABLED=0")
	if err := build.Run(); err != nil {
		t.Fatal("compiled security API build failed")
	}
	f := newAdministrationFixture(t)
	grants, err := os.ReadFile("../../scripts/grant-runtime.sql")
	if err != nil {
		t.Fatal("runtime grant source unavailable")
	}
	sql := strings.ReplaceAll(strings.ReplaceAll(string(grants), "\\set ON_ERROR_STOP on", ""), "else_runtime", f.runtimeRole)
	if _, err := f.admin.Exec(f.base.ctx, sql); err != nil {
		t.Fatal("compiled API runtime grants failed")
	}
	ctx := correlation.New(f.base.ctx)
	f.user(t, "security.empty@example.com")
	empty, err := f.service.Login(ctx, "security.empty@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal("zero-grant session setup failed")
	}
	u := f.user(t, "security.scoped@example.com")
	role, err := f.accounts.CreateRole(ctx, f.actor, "Synthetic scoped security reader", []authorization.Permission{
		authorization.ClientsView, authorization.TasksView, authorization.PlanningView,
		authorization.RemindersView, authorization.BillingView, authorization.PricingView,
		authorization.ActivityView, authorization.IntegrationsView,
	})
	if err != nil {
		t.Fatal("scoped role setup failed")
	}
	assignment, err := f.authorizer.AssignRole(ctx, f.actor, u.ID, role.ID, authorization.Client, clientAID)
	if err != nil {
		t.Fatal("scoped assignment setup failed")
	}
	scoped, err := f.service.Login(ctx, "security.scoped@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal("scoped session setup failed")
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("private API address unavailable")
	}
	address := listener.Addr().String()
	_ = listener.Close()
	origin := "http://" + address
	source, err := url.Parse(f.base.URL)
	if err != nil {
		t.Fatal("private runtime URL invalid")
	}
	runtimeConfig := f.runtime.Config().ConnConfig
	source.User = url.UserPassword(runtimeConfig.User, runtimeConfig.Password)
	apiContext, stopAPI := context.WithCancel(f.base.ctx)
	var logs bytes.Buffer
	command := exec.CommandContext(apiContext, binary)
	command.Env = []string{"DATABASE_URL=" + source.String(), "AUTH_PUBLIC_ORIGIN=" + origin, "AUTH_COOKIE_SECURE=false", "HTTP_ADDRESS=" + address}
	command.Stdout, command.Stderr = &logs, &logs
	if err := command.Start(); err != nil {
		stopAPI()
		t.Fatal("compiled security API startup failed")
	}
	// Read the buffer only after Wait: exec writes it concurrently while running.
	defer func() {
		stopAPI()
		_ = command.Wait()
		for _, forbidden := range []string{"synthetic-security-private-marker", f.login.Token, f.login.CSRF, empty.Token, empty.CSRF, scoped.Token, scoped.CSRF, runtimeConfig.Password} {
			if strings.Contains(logs.String(), forbidden) {
				t.Error("compiled API logs exposed synthetic private input")
			}
		}
	}()
	client := &http.Client{Timeout: 2 * time.Second}
	ready := false
	for n := 0; n < 100; n++ {
		response, err := client.Get(origin + "/ready")
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		select {
		case <-apiContext.Done():
			t.Fatal("compiled API readiness canceled")
		case <-time.After(50 * time.Millisecond):
		}
	}
	if !ready {
		t.Fatal("compiled security API not ready")
	}

	correlationID := regexp.MustCompile(`^[A-Z2-7]{26}$`)
	seenIDs := map[string]bool{}
	safeMessages := map[string][]string{
		"authentication_required": {"Authentication is required."},
		"origin_forbidden":        {"Request origin is not allowed."},
		"csrf_failed":             {"Request verification failed."},
		"permission_denied":       {"Your permissions do not allow this operation.", "Audit access is not permitted.", "Permission denied."},
		"not_found":               {"Client not found.", "Task or client not found.", "Plan, milestone or client not found.", "Reminder or client not found.", "Collection or client not found.", "Pricing, collection or client not found.", "Activity or client not found.", "Overview or client not found.", "Integration or client not found.", "Audit record or client not found."},
	}
	request := func(login *identity.LoginResult, method, path, guard string, status int, code string) []byte {
		t.Helper()
		body := `{"synthetic-security-private-marker":"synthetic-security-private-marker"}`
		r, err := http.NewRequestWithContext(apiContext, method, origin+"/api/v1/"+path, strings.NewReader(body))
		if err != nil {
			t.Fatal("synthetic request construction failed")
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Request-ID", "synthetic-security-private-marker")
		r.Header.Set("Authorization", "Bearer synthetic-security-private-marker")
		if login != nil {
			r.AddCookie(&http.Cookie{Name: "else_session", Value: login.Token})
			if guard != "missing_csrf" {
				r.AddCookie(&http.Cookie{Name: "else_csrf", Value: login.CSRF})
				r.Header.Set("X-CSRF-Token", login.CSRF)
			}
		}
		switch guard {
		case "wrong_origin":
			r.Header.Set("Origin", "https://synthetic-security-private-marker.example")
		case "mismatched_csrf":
			r.Header.Set("X-CSRF-Token", "synthetic-security-private-marker")
		case "foreign_session_csrf":
			r.Header.Set("Cookie", "else_session="+f.login.Token+"; else_csrf="+empty.CSRF)
			r.Header.Set("X-CSRF-Token", empty.CSRF)
		}
		response, err := client.Do(r)
		if err != nil {
			t.Fatal("compiled API request failed")
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
		if err != nil || len(data) > 65536 || response.StatusCode != status {
			t.Fatalf("%s %s guard=%s: HTTP %d, want %d or invalid bounded response", method, path, guard, response.StatusCode, status)
		}
		id := response.Header.Get("X-Request-ID")
		if !correlationID.MatchString(id) || seenIDs[id] || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("X-Content-Type-Options") != "nosniff" || response.Header.Get("Content-Type") != "application/json; charset=utf-8" {
			t.Fatal("compiled API correlation/cache/content guard failed")
		}
		seenIDs[id] = true
		for _, forbidden := range []string{"synthetic-security-private-marker", f.login.Token, f.login.CSRF, empty.Token, empty.CSRF, scoped.Token, scoped.CSRF, runtimeConfig.Password} {
			if bytes.Contains(data, []byte(forbidden)) {
				t.Fatal("compiled API response exposed synthetic private input")
			}
		}
		if code != "" {
			var envelope struct {
				Error struct {
					Code, Message string
					RequestID     string `json:"request_id"`
				} `json:"error"`
			}
			decoder := json.NewDecoder(bytes.NewReader(data))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&envelope) != nil || decoder.Decode(&struct{}{}) != io.EOF || envelope.Error.Code != code || envelope.Error.RequestID != id {
				t.Fatal("compiled API safe denial envelope differs")
			}
			fixedMessage := false
			for _, message := range safeMessages[code] {
				fixedMessage = fixedMessage || envelope.Error.Message == message
			}
			if !fixedMessage {
				t.Fatal("compiled API denial message is not fixed safe text")
			}
			for _, unsafe := range []string{"SQLSTATE", "postgres", "panic", "/workspace", "password", "token_hash"} {
				if bytes.Contains(data, []byte(unsafe)) {
					t.Fatal("compiled API denial exposed internal details")
				}
			}
		}
		return data
	}

	// Fingerprint every ordinary application table, including audit, credential,
	// identity and grant state. Values/hashes never appear in diagnostics.
	fingerprint := func() map[string]string {
		t.Helper()
		rows, err := f.admin.Query(ctx, `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r' ORDER BY c.relname`)
		if err != nil {
			t.Fatal("application state inventory failed")
		}
		var names []string
		for rows.Next() {
			var name string
			if rows.Scan(&name) != nil {
				t.Fatal("application state inventory invalid")
			}
			names = append(names, name)
		}
		rows.Close()
		if rows.Err() != nil || len(names) == 0 {
			t.Fatal("application state inventory incomplete")
		}
		result := make(map[string]string, len(names))
		for _, name := range names {
			var hash string
			query := `SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY to_jsonb(r)::text),'')) FROM ` + (pgx.Identifier{"app", name}).Sanitize() + ` r`
			if f.admin.QueryRow(ctx, query).Scan(&hash) != nil {
				t.Fatal("application state fingerprint failed")
			}
			result[name] = hash
		}
		return result
	}
	before := fingerprint()
	for _, login := range []*identity.LoginResult{&f.login, &empty, &scoped} {
		request(login, "GET", "auth/session", "", 200, "")
	}
	global := []string{"clients", "users", "roles", "permissions", "audit-logs", "releases"}
	for _, path := range global {
		request(&f.login, "GET", path, "", 200, "")
		request(nil, "GET", path, "", 401, "authentication_required")
		request(&empty, "GET", path, "", 403, "permission_denied")
	}
	clientPaths := []string{"", "/tasks", "/plans", "/reminders", "/billing", "/pricing", "/activity", "/overview", "/integrations", "/audit-logs"}
	for _, suffix := range clientPaths {
		path := "clients/" + clientAID + suffix
		request(&f.login, "GET", path, "", 200, "")
		request(nil, "GET", path, "", 401, "authentication_required")
		request(&empty, "GET", path, "", 404, "not_found")
		if suffix != "/audit-logs" { // audit.view is a separate global grant.
			request(&scoped, "GET", path, "", 200, "")
			request(&scoped, "GET", "clients/"+clientBID+suffix, "", 404, "not_found")
		}
	}
	request(nil, "GET", "clients?private=synthetic-security-private-marker", "", 401, "authentication_required")
	mutations := []struct{ method, path string }{
		{"POST", "clients"}, {"PUT", "clients/" + clientAID}, {"POST", "clients/" + clientAID + "/archive"},
		{"POST", "clients/" + clientAID + "/tasks"}, {"POST", "clients/" + clientAID + "/plans"},
		{"POST", "clients/" + clientAID + "/reminders"}, {"POST", "clients/" + clientAID + "/billing"},
		{"POST", "clients/" + clientAID + "/pricing"}, {"POST", "clients/" + clientAID + "/integrations/" + clientBID + "/disconnect"},
		{"POST", "users"}, {"PATCH", "users/" + u.ID}, {"POST", "roles"},
		{"PUT", "roles/" + role.ID + "/permissions"}, {"POST", "users/" + u.ID + "/roles"},
		{"DELETE", "users/" + u.ID + "/roles/" + assignment}, {"POST", "auth/logout"},
	}
	for _, route := range mutations {
		request(nil, route.method, route.path, "", 401, "authentication_required")
		for _, guard := range []string{"wrong_origin", "missing_csrf", "mismatched_csrf", "foreign_session_csrf"} {
			code := "csrf_failed"
			if guard == "wrong_origin" {
				code = "origin_forbidden"
			}
			request(&f.login, route.method, route.path, guard, 403, code)
		}
	}
	if !reflect.DeepEqual(before, fingerprint()) {
		t.Fatal("denied requests or read controls changed application/audit state")
	}
	// The same live session loses access immediately after grant revocation.
	if f.authorizer.RevokeRole(ctx, f.actor, assignment) != nil {
		t.Fatal("scoped grant revocation failed")
	}
	before = fingerprint()
	for _, suffix := range clientPaths {
		request(&scoped, "GET", "clients/"+clientAID+suffix, "", 404, "not_found")
	}
	if !reflect.DeepEqual(before, fingerprint()) {
		t.Fatal("revoked-grant reads changed state")
	}
	if f.service.Logout(ctx, f.login.Session) != nil {
		t.Fatal("session revocation failed")
	}
	before = fingerprint()
	request(&f.login, "GET", "auth/session", "", 401, "authentication_required")
	for _, path := range global {
		request(&f.login, "GET", path, "", 401, "authentication_required")
	}
	for _, suffix := range clientPaths {
		request(&f.login, "GET", "clients/"+clientAID+suffix, "", 401, "authentication_required")
	}
	for _, route := range mutations {
		request(&f.login, route.method, route.path, "", 401, "authentication_required")
	}
	if !reflect.DeepEqual(before, fingerprint()) {
		t.Fatal("revoked-session requests changed state")
	}
}
