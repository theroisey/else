package connections

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

func NewHandler(s *Service, a *identity.Handler, l *slog.Logger) (*Handler, error) {
	if s == nil || a == nil || l == nil {
		return nil, ErrInvalid
	}
	return &Handler{s, a, l}, nil
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	session, ok := h.auth.AuthenticateRequest(w, r)
	if !ok {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/clients/"), "/")
	if strings.HasPrefix(r.URL.Path, "/api/v1/clients/") && len(parts) == 4 && parts[1] == "integrations" && parts[3] == "disconnect" {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			httpapi.WriteError(w, r, 405, "method_not_allowed", "Method not allowed.")
			return
		}
		if !h.auth.VerifyMutation(w, r, session) {
			return
		}
		if !validID(parts[0]) || !validID(parts[2]) || r.URL.RawQuery != "" || r.URL.ForceQuery {
			h.fail(w, r, ErrInvalid)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1024)
		revision, e := decodeDisconnect(r.Body)
		if e != nil {
			h.fail(w, r, e)
			return
		}
		result, e := h.service.Disconnect(r.Context(), session.User.ID, parts[0], parts[2], revision)
		if e != nil {
			h.fail(w, r, e)
			return
		}
		httpapi.WriteJSON(w, r, 200, result)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		httpapi.WriteError(w, r, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/v1/clients/") || (len(parts) != 2 && len(parts) != 3) || !validID(parts[0]) || parts[1] != "integrations" {
		h.fail(w, r, ErrInvalid)
		return
	}
	if len(parts) == 3 {
		if !validID(parts[2]) || r.URL.RawQuery != "" || r.URL.ForceQuery {
			h.fail(w, r, ErrInvalid)
			return
		}
		c, e := h.service.Detail(r.Context(), session.User.ID, parts[0], parts[2])
		if e != nil {
			h.fail(w, r, e)
			return
		}
		httpapi.WriteJSON(w, r, 200, struct {
			Data Connection `json:"data"`
		}{c})
		return
	}
	f, e := parseFilter(r)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	p, e := h.service.List(r.Context(), session.User.ID, parts[0], f)
	if e != nil {
		h.fail(w, r, e)
		return
	}
	httpapi.WriteJSON(w, r, 200, p)
}
func parseFilter(r *http.Request) (Filter, error) {
	f := Filter{Limit: 25}
	if len(r.URL.RawQuery) > 512 || r.URL.ForceQuery {
		return f, ErrInvalid
	}
	q, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return f, ErrInvalid
	}
	for key, v := range q {
		if len(v) != 1 || v[0] == "" {
			return f, ErrInvalid
		}
		switch key {
		case "limit":
			f.Limit, e = strconv.Atoi(v[0])
		case "cursor":
			f.Cursor = v[0]
		default:
			return f, ErrInvalid
		}
		if e != nil {
			return f, ErrInvalid
		}
	}
	if f.Limit < 1 || f.Limit > 100 {
		return f, ErrInvalid
	}
	return f, nil
}
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, e error) {
	status, code, message := 500, "internal_error", "An internal error occurred."
	switch {
	case errors.Is(e, ErrInvalid):
		status, code, message = 400, "invalid_request", "Integration metadata request is invalid."
	case errors.Is(e, ErrMissing):
		status, code, message = 404, "not_found", "Integration or client not found."
	case errors.Is(e, ErrConflict):
		status, code, message = 409, "conflict", "The integration changed or cannot be disconnected. Reload current data before trying again."
	}
	if status == 500 {
		h.logger.ErrorContext(r.Context(), "integration_metadata_error", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
	}
	httpapi.WriteError(w, r, status, code, message)
}
