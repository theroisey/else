package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRequestDeadlineSafeResponseAndEarlierCallerDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	before, _ := ctx.Deadline()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/clients/private-marker", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	RequestMiddleware(slog.New(slog.NewJSONHandler(io.Discard, nil)), RequestDeadline(time.Minute, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deadline, ok := r.Context().Deadline()
		if !ok || deadline.After(before) {
			t.Error("caller deadline was extended")
		}
		<-r.Context().Done()
		WriteError(w, r, 500, "private-marker", "private-marker")
	}))).ServeHTTP(w, r)
	var response errorResponse
	if json.Unmarshal(w.Body.Bytes(), &response) != nil || w.Code != 503 || response.Error.Code != "request_timeout" ||
		response.Error.Message != "The request timed out. Refresh before retrying." || response.Error.RequestID != w.Header().Get("X-Request-ID") ||
		response.Error.RequestID == "" || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "private-marker") {
		t.Fatal("safe timeout response differs")
	}
}

func TestRequestDeadlineDoesNotChangeSuccessOrClientCancellation(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		if canceled {
			cancel()
		}
		w := httptest.NewRecorder()
		RequestDeadline(time.Second, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if canceled {
				WriteError(w, r, 400, "existing_error", "Existing safe error.")
			} else {
				WriteJSON(w, r, 201, map[string]bool{"created": true})
			}
		})).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/", nil).WithContext(ctx))
		cancel()
		if (!canceled && w.Code != 201) || (canceled && (w.Code != 400 || strings.Contains(w.Body.String(), "request_timeout"))) {
			t.Fatal("actual success or cancellation was relabeled")
		}
	}
}
