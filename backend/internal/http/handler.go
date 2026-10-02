package httpapi

import (
	"context"
	"net/http"
	"strings"
)

// ReadinessCheck must honor cancellation and verify actual required dependencies.
// A nil checker intentionally leaves readiness unavailable until persistence is wired.
type ReadinessCheck func(context.Context) error

func (s *Server) handler(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/v1/clients/") {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/clients/"), "/")
		if len(parts) >= 2 && parts[1] == "plans" {
			if s.planning == nil {
				writeError(w, r, http.StatusNotFound, "not_found", "Resource not found.")
				return
			}
			s.planning.ServeHTTP(w, r)
			return
		}
		if len(parts) >= 2 && parts[1] == "tasks" {
			if s.tasks == nil {
				writeError(w, r, http.StatusNotFound, "not_found", "Resource not found.")
				return
			}
			s.tasks.ServeHTTP(w, r)
			return
		}
	}
	if r.URL.Path == "/api/v1/clients" || strings.HasPrefix(r.URL.Path, "/api/v1/clients/") {
		if s.clients == nil {
			writeError(w, r, http.StatusNotFound, "not_found", "Resource not found.")
			return
		}
		s.clients.ServeHTTP(w, r)
		return
	}
	if r.URL.Path == "/api/v1/users" || strings.HasPrefix(r.URL.Path, "/api/v1/users/") ||
		r.URL.Path == "/api/v1/roles" || strings.HasPrefix(r.URL.Path, "/api/v1/roles/") || r.URL.Path == "/api/v1/permissions" {
		if s.administration == nil {
			writeError(w, r, http.StatusNotFound, "not_found", "Resource not found.")
			return
		}
		s.administration.ServeHTTP(w, r)
		return
	}
	if r.URL.Path == "/api/v1/auth/login" || r.URL.Path == "/api/v1/auth/logout" || r.URL.Path == "/api/v1/auth/session" {
		if s.auth == nil {
			writeError(w, r, http.StatusNotFound, "not_found", "Resource not found.")
			return
		}
		s.auth.ServeHTTP(w, r)
		return
	}
	if r.URL.Path != "/health" && r.URL.Path != "/ready" {
		writeError(w, r, http.StatusNotFound, "not_found", "Resource not found.")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
		return
	}
	if r.URL.Path == "/health" {
		writeJSON(w, r, http.StatusOK, struct {
			Status string `json:"status"`
		}{Status: "ok"})
		return
	}
	if s.draining.Load() || s.readiness == nil {
		writeError(w, r, http.StatusServiceUnavailable, "not_ready", "Service is not ready.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.config.ReadinessTimeout)
	defer cancel()
	if err := s.readiness(ctx); err != nil || ctx.Err() != nil || s.draining.Load() {
		writeError(w, r, http.StatusServiceUnavailable, "not_ready", "Service is not ready.")
		return
	}
	writeJSON(w, r, http.StatusOK, struct {
		Status string `json:"status"`
	}{Status: "ready"})
}
