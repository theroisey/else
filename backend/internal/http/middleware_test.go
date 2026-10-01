package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestLogsExcludeSensitiveInputAndUseServerOwnedIDs(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	ids := map[string]bool{}
	for range 2 {
		var contextID string
		handler := RequestMiddleware(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			contextID = RequestID(r.Context())
			writeError(w, r, 404, "not_found", "Resource not found.")
		}))
		r := httptest.NewRequest("GET", "/private-path-secret?token=query-secret", strings.NewReader("body-secret"))
		r.Header.Set("Authorization", "Bearer authorization-secret")
		r.Header.Set("Cookie", "session=cookie-secret")
		r.Header.Set("X-Request-ID", "caller-secret")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		id := w.Header().Get("X-Request-ID")
		if id == "" || id == "caller-secret" || id != contextID || ids[id] {
			t.Fatal("request ID was caller-controlled, missing, inconsistent, or reused")
		}
		ids[id] = true
	}
	if strings.Contains(output.String(), "secret") {
		t.Fatalf("sensitive request details leaked: %s", output.String())
	}
	decoder := json.NewDecoder(&output)
	for range 2 {
		var event map[string]any
		if err := decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		if event["route"] != "unmatched" || event["method"] != "GET" || event["status_code"] != float64(404) ||
			event["duration_ms"] == nil || !ids[event["request_id"].(string)] {
			t.Fatalf("request log lacks safe correlated fields: %v", event)
		}
	}
}

func TestPanicRecoveryNeverExposesPanicValue(t *testing.T) {
	var output bytes.Buffer
	handler := RequestMiddleware(slog.New(slog.NewJSONHandler(&output, nil)), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("password=panic-secret")
	}))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/health", nil))
	if w.Code != 500 || !strings.Contains(w.Body.String(), "internal_error") {
		t.Fatalf("panic was not converted to a safe 500: %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(output.String()+w.Body.String(), "panic-secret") || strings.Contains(output.String(), "goroutine") {
		t.Fatal("panic details or stack leaked")
	}
}

func TestPanicAfterCommittedHeadersAbortsResponse(t *testing.T) {
	var output bytes.Buffer
	handler := RequestMiddleware(slog.New(slog.NewJSONHandler(&output, nil)), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		panic("late-panic-secret")
	}))
	func() {
		defer func() {
			if value := recover(); value != http.ErrAbortHandler {
				t.Fatalf("committed response did not abort safely: %v", value)
			}
		}()
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/health", nil))
	}()
	if strings.Contains(output.String(), "late-panic-secret") || !strings.Contains(output.String(), `"aborted":true`) {
		t.Fatal("aborted response was not logged safely")
	}
}

func TestTransportDiagnosticsAreStructuredAndRedacted(t *testing.T) {
	var output bytes.Buffer
	writer := safeDiagnosticWriter{logger: slog.New(slog.NewJSONHandler(&output, nil))}
	input := []byte("panic /secret-path token=transport-secret")
	n, err := writer.Write(input)
	if n != len(input) || err != nil || strings.Contains(output.String(), "secret") || !strings.Contains(output.String(), "http_transport_error") {
		t.Fatal("transport diagnostic was dropped or leaked raw details")
	}
}
