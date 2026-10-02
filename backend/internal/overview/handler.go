package overview

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
)

type Handler struct {
	service *Service
	auth    *identity.Handler
	logger  *slog.Logger
}

func NewHandler(service *Service, auth *identity.Handler, logger *slog.Logger) (*Handler, error) {
	if service == nil || auth == nil || logger == nil {
		return nil, ErrInvalid
	}
	return &Handler{service, auth, logger}, nil
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	session, ok := h.auth.AuthenticateRequest(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		httpapi.WriteError(w, r, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/clients/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/api/v1/clients/") || len(parts) != 2 || !validID(parts[0]) || parts[1] != "overview" || r.URL.RawQuery != "" || r.URL.ForceQuery {
		h.fail(w, r, ErrInvalid)
		return
	}
	result, e := h.service.Read(r.Context(), session.User.ID, parts[0])
	if e != nil {
		h.fail(w, r, e)
		return
	}
	httpapi.WriteJSON(w, r, 200, struct {
		Data Overview `json:"data"`
	}{result})
}
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, e error) {
	status, code, message := 500, "internal_error", "An internal error occurred."
	switch {
	case errors.Is(e, ErrInvalid):
		status, code, message = 400, "invalid_request", "Overview request is invalid."
	case errors.Is(e, ErrMissing):
		status, code, message = 404, "not_found", "Overview or client not found."
	}
	if status == 500 {
		h.logger.ErrorContext(r.Context(), "overview_error", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
	}
	httpapi.WriteError(w, r, status, code, message)
}
