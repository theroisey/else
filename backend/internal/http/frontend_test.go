package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/theroisey/else/backend/internal/config"
)

func frontendFixture(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"index.html": "<!doctype html><script src=\"/assets/app-123.js\"></script>", "assets/app-123.js": "console.log('synthetic public build')", "assets/font.woff2": "synthetic-font"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return directory
}

func TestSingleOriginFrontendAndAPIBoundaries(t *testing.T) {
	directory := frontendFixture(t)
	c, err := config.Load(func(string) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	c.FrontendDirectory = directory
	auth := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, r, 401, "unauthorized", "Authentication required.")
	})
	server, err := New(c, slog.New(slog.NewTextHandler(io.Discard, nil)), func(context.Context) error { return nil }, auth)
	if err != nil {
		t.Fatal(err)
	}
	// Immutable snapshot: filesystem changes after startup are never served.
	if err := os.WriteFile(filepath.Join(directory, "assets/app-123.js"), []byte("changed-private-fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path string
		status       int
		media        string
	}{
		{"GET", "/", 200, "text/html"}, {"GET", "/login", 200, "text/html"}, {"GET", "/app/clients/example/integrations", 200, "text/html"},
		{"HEAD", "/assets/app-123.js", 200, "text/javascript"}, {"GET", "/assets/font.woff2", 200, "font/woff2"},
		{"POST", "/login", 405, "application/json"}, {"GET", "/api/v1/auth/session", 401, "application/json"},
		{"GET", "/api", 404, "application/json"}, {"GET", "/api/unknown", 404, "application/json"},
		{"GET", "/api/v1/unknown", 404, "application/json"}, {"GET", "/health", 200, "application/json"},
		{"GET", "/ready", 200, "application/json"}, {"GET", "/status", 200, "application/json"},
		{"POST", "/status", 405, "application/json"}, {"GET", "/assets/missing.js", 404, "application/json"},
		{"GET", "/.env", 404, "application/json"}, {"GET", "/index.html.map", 404, "application/json"},
		{"GET", "/app/../.env", 404, "application/json"}, {"GET", "/app//clients", 404, "application/json"},
		{"GET", "/assets/%2e%2e/index.html", 404, "application/json"}, {"GET", "/app/evil%5cpath", 404, "application/json"},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			server.httpServer.Handler.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
			if rec.Code != tc.status || !strings.HasPrefix(rec.Header().Get("Content-Type"), tc.media) {
				t.Fatalf("status/media: %d %s", rec.Code, rec.Header().Get("Content-Type"))
			}
			for name, value := range browserHeaders {
				if got := rec.Header().Values(name); len(got) != 1 || got[0] != value {
					t.Fatalf("policy %s: %v", name, got)
				}
			}
			if strings.Contains(rec.Body.String(), "changed-private-fixture") {
				t.Fatal("served mutable artifact")
			}
			if tc.method == "HEAD" && rec.Body.Len() != 0 {
				t.Fatal("HEAD sent body")
			}
			if tc.media == "application/json" && rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("API/error cache policy changed")
			}
		})
	}
	rec := httptest.NewRecorder()
	server.httpServer.Handler.ServeHTTP(rec, httptest.NewRequest("GET", "/assets/app-123.js", nil))
	req := httptest.NewRequest("GET", "/assets/app-123.js", nil)
	req.Header.Set("If-None-Match", rec.Header().Get("ETag"))
	conditional := httptest.NewRecorder()
	server.httpServer.Handler.ServeHTTP(conditional, req)
	if conditional.Code != 304 || conditional.Body.Len() != 0 || conditional.Header().Get("Cache-Control") != "no-cache" {
		t.Fatal("static conditional revalidation failed")
	}
}

func TestFrontendStartupRejectsUnpublishableArtifacts(t *testing.T) {
	for _, kind := range []string{"missing-index", "empty-index", "credential", "source-map", "symlink", "oversized", "missing-directory"} {
		t.Run(kind, func(t *testing.T) {
			directory := frontendFixture(t)
			var err error
			switch kind {
			case "missing-index":
				err = os.Remove(filepath.Join(directory, "index.html"))
			case "empty-index":
				err = os.WriteFile(filepath.Join(directory, "index.html"), nil, 0600)
			case "credential":
				err = os.WriteFile(filepath.Join(directory, "secret.json"), []byte("private-fixture"), 0600)
			case "source-map":
				err = os.WriteFile(filepath.Join(directory, "assets/app.js.map"), []byte("private-fixture"), 0600)
			case "symlink":
				err = os.Symlink(filepath.Join(directory, "index.html"), filepath.Join(directory, "assets/leak.js"))
			case "oversized":
				var f *os.File
				f, err = os.Create(filepath.Join(directory, "assets/large.js"))
				if err == nil {
					err = f.Truncate((10 << 20) + 1)
					f.Close()
				}
			case "missing-directory":
				directory = filepath.Join(directory, "absent")
			}
			if err != nil {
				t.Fatal(err)
			}
			handler, err := loadFrontend(directory)
			if handler != nil || err == nil || err.Error() != "FRONTEND_DIRECTORY must contain a valid bounded frontend build" {
				t.Fatal("unsafe startup accepted or private error exposed")
			}
		})
	}
}
