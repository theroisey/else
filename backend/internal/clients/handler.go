package clients

import (
	"encoding/json"
	"errors"
	"io"
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
	if r.Method != http.MethodGet && r.Method != http.MethodPost && r.Method != http.MethodPut {
		w.Header().Set("Allow", "GET, POST, PUT")
		httpapi.WriteError(w, r, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	if r.Method != http.MethodGet && !h.auth.VerifyMutation(w, r, session) {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/clients"), "/")
	if len(parts) > 3 || parts[0] != "" || (len(parts) > 1 && !validID(parts[1])) {
		h.fail(w, r, ErrInvalid)
		return
	}
	actor := session.User.ID
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		f, err := filter(r)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		page, err := h.service.List(r.Context(), actor, f)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		httpapi.WriteJSON(w, r, 200, page)
	case len(parts) == 2 && r.Method == http.MethodGet:
		item, err := h.service.Detail(r.Context(), actor, parts[1])
		if err != nil {
			h.fail(w, r, err)
			return
		}
		h.data(w, r, 200, item)
	case len(parts) == 1 && r.Method == http.MethodPost:
		var p Profile
		if !decode(w, r, &p) {
			return
		}
		item, err := h.service.Create(r.Context(), actor, p)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		h.data(w, r, 201, item)
	case len(parts) == 2 && r.Method == http.MethodPut:
		var p struct {
			Profile
			Revision int64 `json:"expected_revision"`
		}
		if !decode(w, r, &p) {
			return
		}
		item, err := h.service.Update(r.Context(), actor, parts[1], p.Revision, p.Profile)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		h.data(w, r, 200, item)
	case len(parts) == 3 && parts[2] == "archive" && r.Method == http.MethodPost:
		var p struct {
			Revision int64 `json:"expected_revision"`
			Confirm  bool  `json:"confirm"`
		}
		if !decode(w, r, &p) {
			return
		}
		if !p.Confirm {
			h.fail(w, r, ErrInvalid)
			return
		}
		item, err := h.service.Archive(r.Context(), actor, parts[1], p.Revision)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		h.data(w, r, 200, item)
	default:
		h.fail(w, r, ErrMissing)
	}
}
func (h *Handler) data(w http.ResponseWriter, r *http.Request, status int, data any) {
	httpapi.WriteJSON(w, r, status, struct {
		Data any `json:"data"`
	}{data})
}
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, message := 500, "internal_error", "An internal error occurred."
	switch {
	case errors.Is(err, ErrInvalid):
		status, code, message = 400, "invalid_request", "Client input or pagination is invalid."
	case errors.Is(err, ErrMissing):
		status, code, message = 404, "not_found", "Client not found."
	case errors.Is(err, ErrDenied):
		status, code, message = 403, "permission_denied", "Your permissions do not allow this operation."
	case errors.Is(err, ErrConflict):
		status, code, message = 409, "conflict", "The client changed or is archived. Reload current data before trying again."
	}
	if status == 500 {
		h.logger.ErrorContext(r.Context(), "client_error", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
	}
	httpapi.WriteError(w, r, status, code, message)
}
func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		httpapi.WriteError(w, r, 400, "invalid_request", "Request body is invalid.")
		return false
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		httpapi.WriteError(w, r, 400, "invalid_request", "Request body is invalid.")
		return false
	}
	return true
}
func filter(r *http.Request) (Filter, error) {
	f := Filter{Limit: 25, Status: "active", Sort: "id"}
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
		case "status":
			f.Status = values[0]
		case "q":
			f.Search = strings.TrimSpace(values[0])
		case "tag":
			f.Tag = strings.ToLower(strings.TrimSpace(values[0]))
		case "sort":
			f.Sort = values[0]
		default:
			return f, ErrInvalid
		}
		if err != nil {
			return f, ErrInvalid
		}
	}
	if !validFilter(f) {
		return f, ErrInvalid
	}
	return f, nil
}
