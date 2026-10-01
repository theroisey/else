package httpapi

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/theroisey/else/backend/internal/correlation"
)

type responseRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *responseRecorder) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.status = status
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseRecorder) Write(value []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(value)
}

func (w *responseRecorder) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// RequestMiddleware supplies server-owned correlation and safe request logging.
func RequestMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		r = r.WithContext(correlation.New(r.Context()))
		id := correlation.ID(r.Context())
		// A server-owned ID prevents caller-controlled correlation or log injection.
		w.Header().Set("X-Request-ID", id)
		recorder := &responseRecorder{ResponseWriter: w, status: http.StatusOK}
		aborted := false
		defer func() {
			logger.InfoContext(r.Context(), "request_completed",
				"request_id", id, "method", safeMethod(r.Method), "route", routeLabel(r.URL.Path),
				"status_code", recorder.status, "duration_ms", time.Since(started).Milliseconds(),
				"aborted", aborted)
		}()
		defer func() {
			if recovered := recover(); recovered != nil {
				if recovered == http.ErrAbortHandler || recorder.wroteHeader {
					aborted = true
					logger.ErrorContext(r.Context(), "request_aborted", "request_id", id)
					panic(http.ErrAbortHandler)
				}
				logger.ErrorContext(r.Context(), "request_failed", "request_id", id, "error_code", "internal_error")
				writeError(recorder, r, http.StatusInternalServerError, "internal_error", "An internal error occurred.")
			}
		}()
		next.ServeHTTP(recorder, r)
	})
}

func routeLabel(path string) string {
	switch path {
	case "/health", "/ready":
		return path
	case "/api/v1/auth/login":
		return "/api/v1/auth/login"
	case "/api/v1/auth/logout":
		return "/api/v1/auth/logout"
	case "/api/v1/auth/session":
		return "/api/v1/auth/session"
	default:
		return "unmatched"
	}
}

func safeMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodOptions, http.MethodConnect, http.MethodTrace:
		return method
	default:
		return "OTHER"
	}
}
