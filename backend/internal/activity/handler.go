package activity

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
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
	if !strings.HasPrefix(r.URL.Path, "/api/v1/clients/") || len(parts) != 2 || !validID(parts[0]) || parts[1] != "activity" {
		h.fail(w, r, ErrInvalid)
		return
	}
	f, err := parseFilter(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	page, err := h.service.List(r.Context(), session.User.ID, parts[0], f)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpapi.WriteJSON(w, r, 200, page)
}
func parseFilter(r *http.Request) (Filter, error) {
	f := Filter{Limit: 25}
	// Cursor <=256; allow a bounded encoded query and reject hostile parsing work.
	if len(r.URL.RawQuery) > 1024 {
		return f, ErrInvalid
	}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return f, ErrInvalid
	}
	for key, values := range q {
		if len(values) != 1 || values[0] == "" {
			return f, ErrInvalid
		}
		switch key {
		case "limit":
			f.Limit, err = strconv.Atoi(values[0])
		case "cursor":
			f.Cursor = values[0]
		default:
			return f, ErrInvalid
		}
		if err != nil {
			return f, ErrInvalid
		}
	}
	if f.Limit < 1 || f.Limit > 100 {
		return f, ErrInvalid
	}
	return f, nil
}
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, message := 500, "internal_error", "An internal error occurred."
	switch {
	case errors.Is(err, ErrInvalid):
		status, code, message = 400, "invalid_request", "Activity pagination is invalid."
	case errors.Is(err, ErrMissing):
		status, code, message = 404, "not_found", "Activity or client not found."
	}
	if status == 500 {
		h.logger.ErrorContext(r.Context(), "activity_error", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
	}
	httpapi.WriteError(w, r, status, code, message)
}
