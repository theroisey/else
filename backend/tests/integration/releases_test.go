//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/buildinfo"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/releases"
)

func releaseFixture(t *testing.T) *administrationFixture {
	t.Helper()
	f := newAdministrationFixture(t)
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	auth, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	h, err := releases.NewHandler(auth, f.authorizer, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = httpapi.RequestMiddleware(logger, h)
	return f
}

func TestReleasesFreshGlobalPermissionAndSessionIsolation(t *testing.T) {
	f := releaseFixture(t)
	ctx := correlation.New(f.base.ctx)
	u := f.user(t, "release.reader@example.com")
	login, err := f.service.Login(ctx, "release.reader@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, nil, "GET", "releases", nil, nil), 401, "authentication_required")
	assertStatus(t, f.request(t, &login, "GET", "releases", nil, nil), 403, "permission_denied")
	role, err := f.accounts.CreateRole(ctx, f.actor, "Synthetic release viewer", []authorization.Permission{authorization.ReleasesView})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.authorizer.AssignRole(ctx, f.actor, u.ID, role.ID, authorization.Client, clientAID); err == nil {
		t.Fatal("global release permission assigned on client")
	}
	assignment := f.assignment(t, u.ID, role.ID)
	var before, after int
	if err = f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		w := f.request(t, &login, "GET", "releases", nil, nil)
		assertStatus(t, w, 200, "")
		var report struct {
			Data releases.Report `json:"data"`
		}
		if w.Body.Len() > 4096 || json.Unmarshal(w.Body.Bytes(), &report) != nil || report.Data.Runtime != (buildinfo.Metadata{Status: "unavailable"}) || report.Data.Deployment.Status != "unavailable" || report.Data.LatestRelease.Status != "unavailable" || report.Data.ImageProvenance.Status != "unavailable" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("release report invented evidence or escaped bounds")
		}
	}
	if err = f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events`).Scan(&after); err != nil || after != before {
		t.Fatal("release read wrote audit")
	}
	f.user(t, "release.other@example.com")
	otherLogin, err := f.service.Login(ctx, "release.other@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &otherLogin, "GET", "releases", nil, nil), 403, "permission_denied")
	if err = f.authorizer.RevokeRole(ctx, f.actor, assignment); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &login, "GET", "releases", nil, nil), 403, "permission_denied")
	f.assignment(t, u.ID, role.ID)
	assertStatus(t, f.request(t, &login, "GET", "releases", nil, nil), 200, "")
	if _, err = f.accounts.DisableUser(ctx, f.actor, u.ID, 1); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &login, "GET", "releases", nil, nil), 401, "authentication_required")
}

func TestReleasesStrictReadOnlyGrammarAndAuthorizationFailure(t *testing.T) {
	f := releaseFixture(t)
	for _, path := range []string{"releases?source=synthetic-private-value", "releases?", "releases/extra"} {
		assertStatus(t, f.request(t, &f.login, "GET", path, nil, nil), 400, "invalid_request")
	}
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
		w := f.request(t, &f.login, method, "releases", nil, nil)
		if w.Code != 405 || w.Header().Get("Allow") != "GET" {
			t.Fatal("release mutation/unsupported method accepted")
		}
	}
	if _, err := f.admin.Exec(f.base.ctx, `REVOKE EXECUTE ON FUNCTION app.authorization_allowed(uuid,text,uuid) FROM `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &f.login, "GET", "releases", nil, nil), 500, "internal_error")
}

func TestReleasesActualCompiledAPIStampIgnoresRuntimeOverrides(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "api")
	revision, builtAt := strings.Repeat("a", 40), "2026-10-03T18:00:00Z"
	buildCtx, done := context.WithTimeout(context.Background(), 2*time.Minute)
	defer done()
	build := exec.CommandContext(buildCtx, "sh", "scripts/build-api.sh", binary, "sha-"+revision, revision, builtAt)
	build.Dir = "../.."
	build.Env = append(os.Environ(), "PATH="+filepath.Join(runtime.GOROOT(), "bin")+":"+os.Getenv("PATH"), "CGO_ENABLED=0")
	if err := build.Run(); err != nil {
		t.Fatal("synthetic stamped API build failed")
	}
	f := newAdministrationFixture(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	ctx, cancel := context.WithCancel(f.base.ctx)
	defer cancel()
	var logs bytes.Buffer
	command := exec.CommandContext(ctx, binary)
	// Reuse the fixture's validated source URL with its runtime identity. pgx's
	// internal ConnString adds empty disabled certificate selectors, which are
	// intentionally outside the public configuration grammar.
	sourceURL, err := url.Parse(f.base.URL)
	if err != nil {
		t.Fatal("synthetic runtime URL construction")
	}
	runtimeConfig := f.runtime.Config().ConnConfig
	sourceURL.User = url.UserPassword(runtimeConfig.User, runtimeConfig.Password)
	command.Env = []string{"DATABASE_URL=" + sourceURL.String(), "AUTH_PUBLIC_ORIGIN=http://" + address, "AUTH_COOKIE_SECURE=false", "HTTP_ADDRESS=" + address, "BUILD_VERSION=synthetic-private-value", "BUILD_REVISION=" + strings.Repeat("b", 40), "BUILD_TIME=2000-01-01T00:00:00Z"}
	command.Stdout = &logs
	command.Stderr = &logs
	if err = command.Start(); err != nil {
		t.Fatal("synthetic stamped API startup failed")
	}
	defer func() { cancel(); _ = command.Wait() }()
	client := &http.Client{Timeout: time.Second}
	ready := false
	for n := 0; n < 100; n++ {
		response, e := client.Get("http://" + address + "/ready")
		if e == nil {
			_ = response.Body.Close()
			if response.StatusCode == 200 {
				ready = true
				break
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("synthetic API readiness canceled")
		case <-time.After(50 * time.Millisecond):
		}
	}
	if !ready {
		cancel()
		_ = command.Wait()
		var event map[string]any
		decoder := json.NewDecoder(bytes.NewReader(logs.Bytes()))
		classification := "unavailable"
		for decoder.Decode(&event) == nil {
			if event["msg"] == "invalid_configuration" {
				classification = "invalid_configuration"
				if detail, ok := event["detail"].(string); ok {
					for _, name := range []string{"DATABASE_URL", "HTTP_ADDRESS", "AUTH_PUBLIC_ORIGIN", "AUTH_COOKIE_SECURE"} {
						if strings.Contains(detail, name) {
							classification = name
						}
					}
				}
			}
			if event["msg"] == "database_startup_failed" {
				classification = "database_startup_failed"
			}
		}
		t.Fatal("synthetic stamped API not ready", classification)
	}
	request, _ := http.NewRequestWithContext(ctx, "GET", "http://"+address+"/api/v1/releases", nil)
	request.AddCookie(&http.Cookie{Name: "else_session", Value: f.login.Token})
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("synthetic release request failed")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	var report struct {
		Data releases.Report `json:"data"`
	}
	if err != nil || response.StatusCode != 200 || len(data) > 4096 || json.Unmarshal(data, &report) != nil || report.Data.Runtime.Status != "available" || report.Data.Runtime.CommitSHA == nil || *report.Data.Runtime.CommitSHA != revision || report.Data.Runtime.Version == nil || *report.Data.Runtime.Version != "sha-"+revision || report.Data.Runtime.BuiltAt == nil || *report.Data.Runtime.BuiltAt != builtAt || bytes.Contains(data, []byte("synthetic-private")) || report.Data.Deployment.Status != "unavailable" {
		t.Fatal("compiled API stamp differs or runtime input escaped")
	}
	// Exercise the same fixture/checker used by actual production Container CI
	// against this real compiled API and disposable PostgreSQL before publishing.
	cookies := filepath.Join(t.TempDir(), "release-cookies.json")
	prepare := exec.CommandContext(ctx, "python3", "scripts/check-release-runtime.py", "prepare", cookies)
	prepare.Dir = "../.."
	sql, e := prepare.Output()
	if e != nil {
		t.Fatal("synthetic container fixture failed")
	}
	if _, e = f.admin.Exec(ctx, string(sql)); e != nil {
		t.Fatal("synthetic container identities invalid")
	}
	verify := exec.CommandContext(ctx, "python3", "scripts/check-release-runtime.py", "verify", cookies, "http://"+address, revision, builtAt)
	verify.Dir = "../.."
	proof, e := verify.Output()
	if e != nil || string(proof) != "CI-produced API build metadata and protected release reads verified.\n" {
		t.Fatal("production container metadata verifier failed")
	}
}

type releaseSpy struct {
	calls   int
	refresh bool
}

func (s *releaseSpy) Observe(_ context.Context, refresh bool) releases.Evidence {
	s.calls++
	s.refresh = refresh
	return releases.Evidence{LatestRelease: releases.Observation{Status: "unavailable", Reason: "authentication_failed"}, ImageProvenance: releases.Observation{Status: "unavailable", Reason: "not_found"}, Deployment: releases.Observation{Status: "unavailable", Reason: "deployment_source_not_connected"}, CheckedAt: "2026-10-05T12:00:00Z"}
}
func TestEvidenceProviderRunsOnlyAfterFreshAuthorizationAndUsesNoStore(t *testing.T) {
	f := newAdministrationFixture(t)
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	auth, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	spy := &releaseSpy{}
	handler, err := releases.NewHandler(auth, f.authorizer, logger, spy)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = httpapi.RequestMiddleware(logger, handler)
	assertStatus(t, f.request(t, nil, "GET", "releases", nil, nil), 401, "authentication_required")
	f.user(t, "release.no-evidence@example.com")
	login, err := f.service.Login(correlation.New(f.base.ctx), "release.no-evidence@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &login, "GET", "releases", nil, nil), 403, "permission_denied")
	assertStatus(t, f.request(t, &f.login, "GET", "releases?repository=evil/source", nil, nil), 400, "invalid_request")
	if spy.calls != 0 {
		t.Fatal("provider contacted before authorization/grammar")
	}
	w := f.request(t, &f.login, "GET", "releases", nil, func(r *http.Request) { r.Header.Set("X-Release-Refresh", "revalidate") })
	assertStatus(t, w, 200, "")
	if spy.calls != 1 || !spy.refresh || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), "authentication_failed") {
		t.Fatal("refresh or partial state lost")
	}
	assertStatus(t, f.request(t, &f.login, "GET", "releases", nil, func(r *http.Request) { r.Header.Set("X-Release-Refresh", "evil/source") }), 400, "invalid_request")
	if spy.calls != 1 {
		t.Fatal("invalid refresh reached provider")
	}
}
