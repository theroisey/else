package reminders

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
	if r.Method != "GET" && r.Method != "POST" && r.Method != "PUT" {
		w.Header().Set("Allow", "GET, POST, PUT")
		httpapi.WriteError(w, r, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	if r.Method != "GET" && !h.auth.VerifyMutation(w, r, session) {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/clients/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/api/v1/clients/") || len(parts) < 2 || len(parts) > 4 || !validID(parts[0]) || parts[1] != "reminders" {
		h.fail(w, r, ErrInvalid)
		return
	}
	actor, client := session.User.ID, strings.ToLower(parts[0])
	owners := len(parts) == 3 && parts[2] == "owners"
	if len(parts) >= 3 && !owners && !validID(parts[2]) {
		h.fail(w, r, ErrInvalid)
		return
	}
	if owners && r.Method != "GET" {
		h.fail(w, r, ErrMissing)
		return
	}
	if r.Method == "GET" && (len(parts) == 2 || owners) {
		f, err := parseFilter(r, owners)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		var page any
		if owners {
			page, err = h.service.Owners(r.Context(), actor, client, f.Cursor, f.Limit)
		} else {
			page, err = h.service.List(r.Context(), actor, client, f)
		}
		if err != nil {
			h.fail(w, r, err)
			return
		}
		httpapi.WriteJSON(w, r, 200, page)
		return
	}
	if r.URL.RawQuery != "" {
		h.fail(w, r, ErrInvalid)
		return
	}
	if r.Method == "GET" && len(parts) == 3 {
		item, err := h.service.Detail(r.Context(), actor, client, parts[2])
		if err != nil {
			h.fail(w, r, err)
			return
		}
		h.data(w, r, 200, item)
		return
	}
	var item Mutation
	var err error
	status := 200
	switch {
	case len(parts) == 2 && r.Method == "POST":
		var input Profile
		if !decode(w, r, &input) {
			return
		}
		item, err = h.service.Create(r.Context(), actor, client, input)
		status = 201
	case len(parts) == 3 && r.Method == "PUT":
		var input struct {
			Profile
			Revision int64 `json:"expected_revision"`
		}
		if !decode(w, r, &input) {
			return
		}
		item, err = h.service.Update(r.Context(), actor, client, parts[2], input.Revision, input.Profile)
	case len(parts) == 4 && r.Method == "POST" && parts[3] == "complete":
		var input struct {
			Revision int64 `json:"expected_revision"`
		}
		if !decode(w, r, &input) {
			return
		}
		item, err = h.service.Complete(r.Context(), actor, client, parts[2], input.Revision)
	case len(parts) == 4 && r.Method == "POST" && parts[3] == "dismiss":
		var input struct {
			Revision int64 `json:"expected_revision"`
			Confirm  bool  `json:"confirm"`
		}
		if !decode(w, r, &input) {
			return
		}
		if !input.Confirm {
			h.fail(w, r, ErrInvalid)
			return
		}
		item, err = h.service.Dismiss(r.Context(), actor, client, parts[2], input.Revision)
	default:
		h.fail(w, r, ErrMissing)
		return
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.data(w, r, status, item)
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
		status, code, message = 400, "invalid_request", "Reminder input or pagination is invalid."
	case errors.Is(err, ErrMissing):
		status, code, message = 404, "not_found", "Reminder or client not found."
	case errors.Is(err, ErrConflict):
		status, code, message = 409, "conflict", "The reminder changed, is terminal, or its client is archived. Reload current data before trying again."
	case errors.Is(err, ErrOwner):
		status, code, message = 400, "invalid_owner", "New owners require active reminder access for this client."
	case errors.Is(err, ErrResource):
		status, code, message = 400, "invalid_resource_link", "New links require independent access to a nonarchived resource belonging to this client."
	case errors.Is(err, ErrSchedule):
		status, code, message = 400, "invalid_schedule", "Provide a valid local time, IANA timezone and matching explicit UTC offset."
	}
	if status == 500 {
		h.logger.ErrorContext(r.Context(), "reminder_error", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
	}
	httpapi.WriteError(w, r, status, code, message)
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		httpapi.WriteError(w, r, 400, "invalid_request", "Request body is invalid.")
		return false
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		httpapi.WriteError(w, r, 400, "invalid_request", "Request body is invalid.")
		return false
	}
	return true
}
func parseFilter(r *http.Request, owners bool) (Filter, error) {
	f := Filter{Limit: 25, Status: "pending", Due: "all", Owner: "any", Sort: "id"}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return f, ErrInvalid
	}
	for key, values := range q {
		if len(values) != 1 || values[0] == "" {
			return f, ErrInvalid
		}
		v := values[0]
		if owners && key != "limit" && key != "cursor" {
			return f, ErrInvalid
		}
		switch key {
		case "limit":
			f.Limit, err = strconv.Atoi(v)
		case "cursor":
			f.Cursor = v
		case "status":
			f.Status = v
		case "due":
			f.Due = v
		case "owner":
			f.Owner = v
		case "q":
			f.Search = strings.TrimSpace(v)
		case "sort":
			f.Sort = v
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
