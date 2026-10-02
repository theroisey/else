package tasks

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
	if !strings.HasPrefix(r.URL.Path, "/api/v1/clients/") || len(parts) < 2 || len(parts) > 4 || !validID(parts[0]) || parts[1] != "tasks" {
		h.fail(w, r, ErrInvalid)
		return
	}
	actor, client := session.User.ID, parts[0]
	if len(parts) == 3 && parts[2] == "assignees" && r.Method == "GET" {
		f, err := parseFilter(r, true)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		page, err := h.service.Assignees(r.Context(), actor, client, f.Cursor, f.Limit)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		httpapi.WriteJSON(w, r, 200, page)
		return
	}
	if len(parts) >= 3 && !validID(parts[2]) {
		h.fail(w, r, ErrInvalid)
		return
	}
	if len(parts) != 2 || r.Method != "GET" {
		if r.URL.RawQuery != "" {
			h.fail(w, r, ErrInvalid)
			return
		}
	}
	switch {
	case len(parts) == 2 && r.Method == "GET":
		f, err := parseFilter(r, false)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		page, err := h.service.List(r.Context(), actor, client, f)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		httpapi.WriteJSON(w, r, 200, page)
	case len(parts) == 3 && r.Method == "GET":
		item, err := h.service.Detail(r.Context(), actor, client, parts[2])
		if err != nil {
			h.fail(w, r, err)
			return
		}
		h.data(w, r, 200, item)
	case len(parts) == 2 && r.Method == "POST":
		var input CreateInput
		if !decode(w, r, &input) {
			return
		}
		item, err := h.service.Create(r.Context(), actor, client, input)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		h.data(w, r, 201, item)
	case len(parts) == 3 && r.Method == "PUT":
		var input struct {
			Profile
			Revision int64 `json:"expected_revision"`
		}
		if !decode(w, r, &input) {
			return
		}
		item, err := h.service.Update(r.Context(), actor, client, parts[2], input.Revision, input.Profile)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		h.data(w, r, 200, item)
	case len(parts) == 4 && parts[3] == "status" && r.Method == "POST":
		var input struct {
			Status   string `json:"status"`
			Revision int64  `json:"expected_revision"`
		}
		if !decode(w, r, &input) {
			return
		}
		item, err := h.service.Transition(r.Context(), actor, client, parts[2], input.Revision, input.Status)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		h.data(w, r, 200, item)
	case len(parts) == 4 && parts[3] == "archive" && r.Method == "POST":
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
		item, err := h.service.Archive(r.Context(), actor, client, parts[2], input.Revision)
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
		status, code, message = 400, "invalid_request", "Task input or pagination is invalid."
	case errors.Is(err, ErrMissing):
		status, code, message = 404, "not_found", "Task or client not found."
	case errors.Is(err, ErrConflict):
		status, code, message = 409, "conflict", "The task changed, is terminal, or the task or client is archived. Reload current data before trying again."
	case errors.Is(err, ErrTransition):
		status, code, message = 409, "invalid_transition", "This task status transition is not allowed."
	case errors.Is(err, ErrAssignee):
		status, code, message = 400, "invalid_assignee", "Choose an active assignee with task access for this client."
	}
	if status == 500 {
		h.logger.ErrorContext(r.Context(), "task_error", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
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
func parseFilter(r *http.Request, candidates bool) (Filter, error) {
	f := Filter{Limit: 25, Status: "all", Priority: "all", Archived: "false", Sort: "id"}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return f, ErrInvalid
	}
	for key, values := range q {
		if len(values) != 1 || values[0] == "" || (candidates && key != "limit" && key != "cursor") {
			return f, ErrInvalid
		}
		switch key {
		case "limit":
			f.Limit, err = strconv.Atoi(values[0])
		case "cursor":
			f.Cursor = values[0]
		case "status":
			f.Status = values[0]
		case "priority":
			f.Priority = values[0]
		case "assignee":
			f.Assignee = values[0]
		case "q":
			f.Search = strings.TrimSpace(values[0])
		case "tag":
			f.Tag = strings.ToLower(strings.TrimSpace(values[0]))
		case "archived":
			f.Archived = values[0]
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
