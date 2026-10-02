package pricing

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
	if r.Method != "GET" && r.Method != "POST" {
		w.Header().Set("Allow", "GET, POST")
		httpapi.WriteError(w, r, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	if r.Method != "GET" && !h.auth.VerifyMutation(w, r, session) {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/clients/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/api/v1/clients/") || len(parts) < 2 || len(parts) > 6 || !validID(parts[0]) {
		h.fail(w, r, ErrInvalid)
		return
	}
	actor, client := session.User.ID, strings.ToLower(parts[0])
	snapshot := len(parts) == 4 && parts[1] == "billing" && parts[3] == "pricing-snapshot"
	preview := len(parts) == 3 && parts[1] == "pricing" && parts[2] == "preview"
	if parts[1] != "pricing" && !snapshot || len(parts) >= 3 && !preview && !validID(parts[2]) || len(parts) >= 4 && !snapshot && parts[3] != "versions" || len(parts) >= 5 && !validID(parts[4]) || len(parts) == 6 && parts[5] != "collections" {
		h.fail(w, r, ErrInvalid)
		return
	}
	if r.Method == "GET" && (len(parts) == 2 || len(parts) == 4 && !snapshot) {
		cursor, limit, e := parsePage(r)
		if e != nil {
			h.fail(w, r, e)
			return
		}
		var data any
		if len(parts) == 2 {
			data, e = h.service.List(r.Context(), actor, client, cursor, limit)
		} else {
			data, e = h.service.Versions(r.Context(), actor, client, parts[2], cursor, limit)
		}
		if e != nil {
			h.fail(w, r, e)
			return
		}
		httpapi.WriteJSON(w, r, 200, data)
		return
	}
	if r.URL.RawQuery != "" {
		h.fail(w, r, ErrInvalid)
		return
	}
	var data any
	var e error
	status := 200
	switch {
	case r.Method == "GET" && snapshot:
		data, e = h.service.Snapshot(r.Context(), actor, client, parts[2])
	case r.Method == "GET" && len(parts) == 3 && !preview:
		data, e = h.service.Detail(r.Context(), actor, client, parts[2])
	case r.Method == "GET" && len(parts) == 5:
		data, e = h.service.Version(r.Context(), actor, client, parts[2], parts[4])
	case r.Method == "POST" && (len(parts) == 2 || preview):
		var p Profile
		if !decode(w, r, &p) {
			return
		}
		if preview {
			data, e = h.service.Preview(r.Context(), actor, client, p)
		} else {
			data, e = h.service.Create(r.Context(), actor, client, p)
			status = 201
		}
	case r.Method == "POST" && len(parts) == 4 && !snapshot:
		var p struct {
			Profile
			Revision string `json:"expected_revision"`
		}
		if !decode(w, r, &p) {
			return
		}
		data, e = h.service.Append(r.Context(), actor, client, parts[2], p.Revision, p.Profile)
		status = 201
	case r.Method == "POST" && len(parts) == 6:
		var p struct {
			CopyInput
			Revision string `json:"expected_revision"`
		}
		if !decode(w, r, &p) {
			return
		}
		var result CollectionMutation
		result, e = h.service.Copy(r.Context(), actor, client, parts[2], parts[4], p.Revision, p.CopyInput)
		data = result
		if !result.Replayed {
			status = 201
		}
	default:
		h.fail(w, r, ErrMissing)
		return
	}
	if e != nil {
		h.fail(w, r, e)
		return
	}
	httpapi.WriteJSON(w, r, status, struct {
		Data any `json:"data"`
	}{data})
}
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, e error) {
	status, code, message := 500, "internal_error", "An internal error occurred."
	switch {
	case errors.Is(e, ErrInvalid):
		status, code, message = 400, "invalid_request", "Pricing input or pagination is invalid."
	case errors.Is(e, ErrMissing):
		status, code, message = 404, "not_found", "Pricing, collection or client not found."
	case errors.Is(e, ErrConflict):
		status, code, message = 409, "conflict", "The revision, effective window, command identity or client lifecycle prevents this write. Reload current data before trying again."
	}
	if status == 500 {
		h.logger.ErrorContext(r.Context(), "pricing_error", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
	}
	httpapi.WriteError(w, r, status, code, message)
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		httpapi.WriteError(w, r, 400, "invalid_request", "Request body is invalid.")
		return false
	}
	if e := d.Decode(&struct{}{}); e != io.EOF {
		httpapi.WriteError(w, r, 400, "invalid_request", "Request body is invalid.")
		return false
	}
	return true
}
func parsePage(r *http.Request) (string, int, error) {
	q, e := url.ParseQuery(r.URL.RawQuery)
	limit := 25
	cursor := ""
	if e != nil {
		return cursor, limit, ErrInvalid
	}
	for key, values := range q {
		if len(values) != 1 || values[0] == "" {
			return cursor, limit, ErrInvalid
		}
		switch key {
		case "cursor":
			cursor = values[0]
		case "limit":
			limit, e = strconv.Atoi(values[0])
			if e != nil {
				return cursor, limit, ErrInvalid
			}
		default:
			return cursor, limit, ErrInvalid
		}
	}
	if !validPage(cursor, limit) {
		return cursor, limit, ErrInvalid
	}
	return cursor, limit, nil
}
