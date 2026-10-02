package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/config"
)

func TestActivityRoutesUseDedicatedProtectedAdapter(t *testing.T) {
	other := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(418) })
	activity := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(401) })
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	s, err := NewWithActivity(testConfig(t), logger, nil, other, other, other, other, other, other, activity)
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "/private"} {
		w := httptest.NewRecorder()
		s.httpServer.Handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/clients/11111111-1111-4111-8111-111111111111/activity"+suffix, nil))
		if w.Code != 401 {
			t.Fatal("activity bypassed dedicated protected adapter")
		}
	}
	for _, suffix := range []string{"", "/tasks", "/plans", "/reminders"} {
		w := httptest.NewRecorder()
		s.httpServer.Handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/clients/11111111-1111-4111-8111-111111111111"+suffix, nil))
		if w.Code != 418 {
			t.Fatal("existing domain entered activity handler")
		}
	}
	if _, err := NewWithActivity(testConfig(t), logger, nil, other, other, other, other, other, other, nil); err == nil {
		t.Fatal("nil activity handler accepted")
	}
}

func TestClientRoutesUseProtectedAdapter(t *testing.T) {
	var paths []string
	protected := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		w.WriteHeader(http.StatusUnauthorized)
	})
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	s, err := NewWithClients(testConfig(t), logger, nil, protected, protected, protected)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/clients", "/api/v1/clients/11111111-1111-4111-8111-111111111111", "/api/v1/clients/11111111-1111-4111-8111-111111111111/archive"} {
		w := httptest.NewRecorder()
		s.httpServer.Handler.ServeHTTP(w, httptest.NewRequest("POST", path, nil))
		if w.Code != http.StatusUnauthorized {
			t.Fatal("client route bypassed adapter")
		}
	}
	if len(paths) != 3 {
		t.Fatal("client route not registered")
	}
}

func TestTaskRoutesUseDedicatedProtectedAdapter(t *testing.T) {
	other := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(418) })
	tasks := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(401) })
	s, err := NewWithTasks(testConfig(t), slog.New(slog.NewJSONHandler(io.Discard, nil)), nil, other, other, other, tasks)
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "/assignees", "/11111111-1111-4111-8111-111111111111", "/11111111-1111-4111-8111-111111111111/status", "/11111111-1111-4111-8111-111111111111/archive"} {
		w := httptest.NewRecorder()
		s.httpServer.Handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/clients/11111111-1111-4111-8111-111111111111/tasks"+suffix, nil))
		if w.Code != 401 {
			t.Fatal("task route bypassed dedicated adapter")
		}
	}
	w := httptest.NewRecorder()
	s.httpServer.Handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/clients/11111111-1111-4111-8111-111111111111", nil))
	if w.Code != 418 {
		t.Fatal("client route routed into task handler")
	}
}

func TestPlanningRoutesUseDedicatedProtectedAdapter(t *testing.T) {
	other := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(418) })
	planning := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(401) })
	s, err := NewWithPlanning(testConfig(t), slog.New(slog.NewJSONHandler(io.Discard, nil)), nil, other, other, other, other, planning)
	if err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/clients/11111111-1111-4111-8111-111111111111/plans"
	for _, suffix := range []string{"", "/11111111-1111-4111-8111-111111111111", "/11111111-1111-4111-8111-111111111111/status", "/11111111-1111-4111-8111-111111111111/task-candidates", "/11111111-1111-4111-8111-111111111111/milestones", "/11111111-1111-4111-8111-111111111111/milestones/22222222-2222-4222-8222-222222222222/task-links"} {
		w := httptest.NewRecorder()
		s.httpServer.Handler.ServeHTTP(w, httptest.NewRequest("GET", base+suffix, nil))
		if w.Code != 401 {
			t.Fatal("planning route bypassed dedicated adapter")
		}
	}
	w := httptest.NewRecorder()
	s.httpServer.Handler.ServeHTTP(w, httptest.NewRequest("GET", strings.TrimSuffix(base, "/plans")+"/tasks", nil))
	if w.Code != 418 {
		t.Fatal("task route entered planning handler")
	}
}

func TestReminderRoutesUseDedicatedProtectedAdapter(t *testing.T) {
	other := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(418) })
	reminders := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(401) })
	s, err := NewWithReminders(testConfig(t), slog.New(slog.NewJSONHandler(io.Discard, nil)), nil, other, other, other, other, other, reminders)
	if err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/clients/11111111-1111-4111-8111-111111111111/reminders"
	for _, suffix := range []string{"", "/owners", "/22222222-2222-4222-8222-222222222222", "/22222222-2222-4222-8222-222222222222/complete", "/22222222-2222-4222-8222-222222222222/dismiss"} {
		w := httptest.NewRecorder()
		s.httpServer.Handler.ServeHTTP(w, httptest.NewRequest("GET", base+suffix, nil))
		if w.Code != 401 {
			t.Fatal("reminder route bypassed protected adapter")
		}
	}
	for _, module := range []string{"tasks", "plans"} {
		w := httptest.NewRecorder()
		s.httpServer.Handler.ServeHTTP(w, httptest.NewRequest("GET", strings.TrimSuffix(base, "/reminders")+"/"+module, nil))
		if w.Code != 418 {
			t.Fatal("another module entered reminders")
		}
	}
	if _, err := NewWithReminders(testConfig(t), slog.New(slog.NewJSONHandler(io.Discard, nil)), nil, other, other, other, other, other, nil); err == nil {
		t.Fatal("nil reminder handler accepted")
	}
}

func testConfig(t *testing.T) config.Config {
	t.Helper()
	c, err := config.Load(func(string) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func testServer(t *testing.T, readiness ReadinessCheck) *Server {
	t.Helper()
	s, err := New(testConfig(t), slog.New(slog.NewJSONHandler(io.Discard, nil)), readiness)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestHealthReadinessAndSafeErrors(t *testing.T) {
	for _, test := range []struct {
		name, method, path, code string
		check                    ReadinessCheck
		status                   int
	}{
		{"liveness without database", "GET", "/health", "", nil, 200},
		{"unconfigured readiness", "GET", "/ready", "not_ready", nil, 503},
		{"successful real check", "GET", "/ready", "", func(context.Context) error { return nil }, 200},
		{"failed dependency", "GET", "/ready", "not_ready", func(context.Context) error { return errors.New("password=secret-value") }, 503},
		{"no business routes", "GET", "/api/v1/clients", "not_found", nil, 404},
		{"exact health path", "GET", "/health/", "not_found", nil, 404},
		{"mutation denied", "POST", "/health", "method_not_allowed", nil, 405},
		{"readiness mutation denied", "DELETE", "/ready", "method_not_allowed", nil, 405},
		{"head liveness", "HEAD", "/health", "", nil, 200},
		{"head readiness", "HEAD", "/ready", "not_ready", nil, 503},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := testServer(t, test.check)
			r := httptest.NewRequest(test.method, test.path, nil)
			w := httptest.NewRecorder()
			s.httpServer.Handler.ServeHTTP(w, r)
			if w.Code != test.status {
				t.Fatalf("status = %d, want %d", w.Code, test.status)
			}
			if w.Header().Get("X-Request-ID") == "" || w.Header().Get("Cache-Control") != "no-store" ||
				w.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
				t.Fatalf("missing safe response headers: %v", w.Header())
			}
			if test.method == "HEAD" {
				if w.Body.Len() != 0 {
					t.Fatal("HEAD returned a body")
				}
				return
			}
			if strings.Contains(w.Body.String(), "secret-value") {
				t.Fatal("dependency error leaked")
			}
			if test.code != "" {
				var response errorResponse
				if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
					t.Fatal(err)
				}
				if response.Error.Code != test.code || response.Error.RequestID != w.Header().Get("X-Request-ID") {
					t.Fatalf("unsafe or inconsistent error envelope: %+v", response)
				}
			}
			if test.status == 405 && w.Header().Get("Allow") != "GET, HEAD" {
				t.Fatal("405 missing allowed methods")
			}
		})
	}
}

func TestReadinessReceivesDeadlineAndRequestID(t *testing.T) {
	c := testConfig(t)
	c.ReadinessTimeout = 10 * time.Millisecond
	var checkID string
	s, err := New(c, slog.New(slog.NewJSONHandler(io.Discard, nil)), func(ctx context.Context) error {
		if _, exists := ctx.Deadline(); !exists {
			t.Error("readiness check has no deadline")
		}
		checkID = RequestID(ctx)
		<-ctx.Done()
		// Even a checker that incorrectly returns nil after cancellation must
		// not turn the timed-out dependency into a healthy response.
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.httpServer.Handler.ServeHTTP(w, httptest.NewRequest("GET", "/ready", nil))
	if w.Code != 503 || checkID == "" || checkID != w.Header().Get("X-Request-ID") {
		t.Fatalf("timeout or correlation contract failed: status %d, id %q", w.Code, checkID)
	}
}

func TestReadinessWhileDraining(t *testing.T) {
	s := testServer(t, func(context.Context) error { t.Fatal("draining server checked dependencies"); return nil })
	s.draining.Store(true)
	w := httptest.NewRecorder()
	s.httpServer.Handler.ServeHTTP(w, httptest.NewRequest("GET", "/ready", nil))
	if w.Code != 503 {
		t.Fatalf("draining server returned %d", w.Code)
	}
}
