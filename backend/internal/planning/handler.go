package planning

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

type route struct {
	client, parent, target, action string
	milestone, collection          bool
}

func parseRoute(path string) (route, error) {
	var r route
	if !strings.HasPrefix(path, "/api/v1/clients/") {
		return r, ErrInvalid
	}
	p := strings.Split(strings.TrimPrefix(path, "/api/v1/clients/"), "/")
	if len(p) < 2 || len(p) > 6 || !validID(p[0]) || p[1] != "plans" {
		return r, ErrInvalid
	}
	r.client = strings.ToLower(p[0])
	if len(p) == 2 {
		r.collection = true
		return r, nil
	}
	if !validID(p[2]) {
		return r, ErrInvalid
	}
	r.target = strings.ToLower(p[2])
	if len(p) == 3 {
		return r, nil
	}
	if p[3] != "milestones" {
		if len(p) != 4 || (p[3] != "status" && p[3] != "archive" && p[3] != "task-candidates") {
			return r, ErrMissing
		}
		r.action = p[3]
		return r, nil
	}
	r.parent = r.target
	r.target = ""
	r.milestone = true
	if len(p) == 4 {
		r.collection = true
		return r, nil
	}
	if !validID(p[4]) {
		return r, ErrInvalid
	}
	r.target = strings.ToLower(p[4])
	if len(p) == 6 {
		if p[5] != "status" && p[5] != "archive" && p[5] != "task-links" {
			return r, ErrMissing
		}
		r.action = p[5]
	}
	return r, nil
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
	path, err := parseRoute(r.URL.Path)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	actor := session.User.ID
	if r.Method == "GET" {
		h.get(w, r, actor, path)
		return
	}
	if r.URL.RawQuery != "" {
		h.fail(w, r, ErrInvalid)
		return
	}
	var result Mutation
	switch {
	case (path.collection && r.Method == "POST") || (path.action == "" && !path.collection && r.Method == "PUT"):
		var profile Profile
		var revision int64
		if path.milestone {
			var input struct {
				MilestoneProfile
				Revision int64 `json:"expected_revision"`
			}
			if path.collection {
				var p MilestoneProfile
				if !decode(w, r, &p) {
					return
				}
				profile = p.profile()
			} else {
				if !decode(w, r, &input) {
					return
				}
				profile = input.MilestoneProfile.profile()
				revision = input.Revision
			}
		} else {
			var input struct {
				Profile
				Revision int64 `json:"expected_revision"`
			}
			if path.collection {
				if !decode(w, r, &profile) {
					return
				}
			} else {
				if !decode(w, r, &input) {
					return
				}
				profile = input.Profile
				revision = input.Revision
			}
		}
		if path.collection {
			result, err = h.service.Create(r.Context(), actor, path.client, path.parent, profile)
		} else {
			result, err = h.service.Update(r.Context(), actor, path.client, path.parent, path.target, revision, profile)
		}
	case path.action == "status" && r.Method == "POST":
		var input struct {
			Status   string `json:"status"`
			Revision int64  `json:"expected_revision"`
		}
		if !decode(w, r, &input) {
			return
		}
		result, err = h.service.Transition(r.Context(), actor, path.client, path.parent, path.target, input.Revision, input.Status)
	case path.action == "archive" && r.Method == "POST":
		var input struct {
			Confirm  bool  `json:"confirm"`
			Revision int64 `json:"expected_revision"`
		}
		if !decode(w, r, &input) {
			return
		}
		if !input.Confirm {
			h.fail(w, r, ErrInvalid)
			return
		}
		result, err = h.service.Archive(r.Context(), actor, path.client, path.parent, path.target, input.Revision)
	case path.action == "task-links" && r.Method == "PUT":
		var input struct {
			TaskIDs  *[]string `json:"task_ids"`
			Revision int64     `json:"expected_revision"`
		}
		if !decode(w, r, &input) {
			return
		}
		if input.TaskIDs == nil {
			h.fail(w, r, ErrInvalid)
			return
		}
		result, err = h.service.ReplaceLinks(r.Context(), actor, path.client, path.parent, path.target, input.Revision, *input.TaskIDs)
	default:
		h.fail(w, r, ErrMissing)
		return
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	status := 200
	if path.collection {
		status = 201
	}
	h.data(w, r, status, result)
}
func (h *Handler) get(w http.ResponseWriter, r *http.Request, actor string, path route) {
	if !path.collection && path.action != "task-candidates" && path.action != "task-links" {
		if path.action != "" {
			h.fail(w, r, ErrMissing)
			return
		}
		if r.URL.RawQuery != "" {
			h.fail(w, r, ErrInvalid)
			return
		}
		item, err := h.service.Detail(r.Context(), actor, path.client, path.parent, path.target)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		h.data(w, r, 200, item)
		return
	}
	f, err := parseFilter(r, path.milestone, path.action)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var data any
	switch path.action {
	case "task-candidates":
		data, err = h.service.Candidates(r.Context(), actor, path.client, path.target, f)
	case "task-links":
		data, err = h.service.Links(r.Context(), actor, path.client, path.parent, path.target, f)
	default:
		data, err = h.service.List(r.Context(), actor, path.client, path.parent, f)
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpapi.WriteJSON(w, r, 200, data)
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
		status, code, message = 400, "invalid_request", "Planning input or pagination is invalid."
	case errors.Is(err, ErrMissing):
		status, code, message = 404, "not_found", "Plan, milestone or client not found."
	case errors.Is(err, ErrConflict):
		status, code, message = 409, "conflict", "The planning record changed, is terminal, or it or its parent is archived. Reload current data before trying again."
	case errors.Is(err, ErrTransition):
		status, code, message = 409, "invalid_transition", "This planning status transition is not allowed."
	case errors.Is(err, ErrDates):
		status, code, message = 400, "invalid_dates", "Plan dates must be ordered and contain nonarchived milestone due dates."
	case errors.Is(err, ErrLink):
		status, code, message = 400, "invalid_task_link", "New links require task access and active tasks belonging to this client."
	}
	if status == 500 {
		h.logger.ErrorContext(r.Context(), "planning_error", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
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
func parseFilter(r *http.Request, milestone bool, mode string) (Filter, error) {
	f := Filter{Limit: 25, Status: "all", Archived: "false", Sort: "id"}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return f, ErrInvalid
	}
	for key, values := range q {
		if len(values) != 1 || values[0] == "" {
			return f, ErrInvalid
		}
		v := values[0]
		switch key {
		case "limit":
			f.Limit, err = strconv.Atoi(v)
		case "cursor":
			f.Cursor = v
		case "sort":
			f.Sort = v
		case "q":
			if mode == "task-links" {
				return f, ErrInvalid
			}
			f.Search = strings.TrimSpace(v)
		case "status":
			if mode != "" {
				return f, ErrInvalid
			}
			f.Status = v
		case "archived":
			if mode == "task-candidates" {
				return f, ErrInvalid
			}
			f.Archived = v
		default:
			return f, ErrInvalid
		}
		if err != nil {
			return f, ErrInvalid
		}
	}
	if !validFilter(f, milestone) {
		return f, ErrInvalid
	}
	return f, nil
}
