package auditreader

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

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
func route(path string) (scope, id string, err error) {
	var tail string
	if path == "/api/v1/audit-logs" || strings.HasPrefix(path, "/api/v1/audit-logs/") {
		tail = strings.TrimPrefix(path, "/api/v1/audit-logs")
	} else if strings.HasPrefix(path, "/api/v1/clients/") {
		p := strings.Split(strings.TrimPrefix(path, "/api/v1/clients/"), "/")
		if len(p) < 2 || len(p) > 3 || !validID(p[0]) || p[1] != "audit-logs" {
			return "", "", ErrInvalid
		}
		scope = strings.ToLower(p[0])
		if len(p) == 3 {
			tail = "/" + p[2]
		}
	} else {
		return "", "", ErrInvalid
	}
	if tail != "" {
		id = strings.TrimPrefix(tail, "/")
		if !validID(id) {
			return "", "", ErrInvalid
		}
		id = strings.ToLower(id)
	}
	return scope, id, nil
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
	scope, id, err := route(r.URL.Path)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if id != "" {
		if r.URL.RawQuery != "" {
			h.fail(w, r, ErrInvalid)
			return
		}
		d, err := h.service.Detail(r.Context(), session.User.ID, scope, id)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		httpapi.WriteJSON(w, r, 200, struct {
			Data Detail `json:"data"`
		}{d})
		return
	}
	f, err := parseFilter(r, scope)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	p, err := h.service.List(r.Context(), session.User.ID, scope, f)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpapi.WriteJSON(w, r, 200, p)
}
func parseFilter(r *http.Request, scope string) (Filter, error) {
	f := Filter{Limit: 25}
	if len(r.URL.RawQuery) > 2048 {
		return f, ErrInvalid
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return f, ErrInvalid
	}
	for key, values := range query {
		if len(values) != 1 || values[0] == "" {
			return f, ErrInvalid
		}
		v := values[0]
		switch key {
		case "limit":
			f.Limit, err = strconv.Atoi(v)
		case "cursor":
			f.Cursor = v
		case "actor_id":
			f.ActorID = v
		case "actor_kind":
			f.ActorKind = v
		case "event_type":
			f.EventType = v
		case "client_id":
			if scope != "" {
				return f, ErrInvalid
			}
			f.ClientID = v
		case "resource_kind":
			f.ResourceKind = v
		case "resource_id":
			f.ResourceID = v
		case "request_id":
			f.RequestID = v
		case "from", "to":
			if !timestampPattern.MatchString(v) {
				return f, ErrInvalid
			}
			var t time.Time
			t, err = time.Parse(time.RFC3339Nano, v)
			if !strings.HasSuffix(v, "Z") {
				return f, ErrInvalid
			}
			if key == "from" {
				f.From = &t
			} else {
				f.To = &t
			}
		default:
			return f, ErrInvalid
		}
		if err != nil {
			return f, ErrInvalid
		}
	}
	return normalize(scope, f)
}
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, message := 500, "internal_error", "An internal error occurred."
	switch {
	case errors.Is(err, ErrInvalid):
		status, code, message = 400, "invalid_request", "Audit filters or pagination are invalid."
	case errors.Is(err, ErrDenied):
		status, code, message = 403, "permission_denied", "Audit access is not permitted."
	case errors.Is(err, ErrMissing):
		status, code, message = 404, "not_found", "Audit record or client not found."
	}
	if status == 500 {
		h.logger.ErrorContext(r.Context(), "audit_read_error", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
	}
	httpapi.WriteError(w, r, status, code, message)
}
