package billing

import (
	"encoding/json"
	"errors"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
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
	if r.Method != "GET" && r.Method != "POST" && r.Method != "PUT" {
		w.Header().Set("Allow", "GET, POST, PUT")
		httpapi.WriteError(w, r, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	if r.Method != "GET" && !h.auth.VerifyMutation(w, r, session) {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/clients/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/api/v1/clients/") || len(parts) < 2 || len(parts) > 4 || !validID(parts[0]) || parts[1] != "billing" {
		h.fail(w, r, ErrInvalid)
		return
	}
	actor, client := session.User.ID, strings.ToLower(parts[0])
	directory := len(parts) == 3 && (parts[2] == "summary" || parts[2] == "currencies")
	if len(parts) >= 3 && !directory && !validID(parts[2]) {
		h.fail(w, r, ErrInvalid)
		return
	}
	payments := len(parts) == 4 && parts[3] == "payments"
	if r.Method == "GET" && (len(parts) == 2 || payments) {
		f, e := parseFilter(r, payments)
		if e != nil {
			h.fail(w, r, e)
			return
		}
		var data any
		if payments {
			data, e = h.service.Payments(r.Context(), actor, client, parts[2], f.Cursor, f.Limit)
		} else {
			data, e = h.service.List(r.Context(), actor, client, f)
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
	if r.Method == "GET" && len(parts) == 3 {
		var data any
		var e error
		switch parts[2] {
		case "summary":
			data, e = h.service.Summary(r.Context(), actor, client)
		case "currencies":
			data, e = h.service.Currencies(r.Context(), actor, client)
		default:
			data, e = h.service.Detail(r.Context(), actor, client, parts[2])
		}
		if e != nil {
			h.fail(w, r, e)
			return
		}
		h.data(w, r, 200, data)
		return
	}
	var result Mutation
	var e error
	status := 200
	switch {
	case r.Method == "POST" && len(parts) == 2:
		var p Profile
		if !decode(w, r, &p) {
			return
		}
		result, e = h.service.Create(r.Context(), actor, client, p)
		status = 201
	case r.Method == "PUT" && len(parts) == 3 && !directory:
		var p struct {
			Profile
			Revision string `json:"expected_revision"`
		}
		if !decode(w, r, &p) {
			return
		}
		result, e = h.service.Update(r.Context(), actor, client, parts[2], p.Revision, p.Profile)
	case r.Method == "POST" && payments:
		var p struct {
			PaymentInput
			Revision string `json:"expected_revision"`
		}
		if !decode(w, r, &p) {
			return
		}
		result, e = h.service.RecordPayment(r.Context(), actor, client, parts[2], p.Revision, p.PaymentInput)
		if !result.Replayed {
			status = 201
		}
	case r.Method == "POST" && len(parts) == 4 && parts[3] == "cancel":
		var p struct {
			Revision string `json:"expected_revision"`
			Confirm  bool   `json:"confirm"`
		}
		if !decode(w, r, &p) {
			return
		}
		if !p.Confirm {
			h.fail(w, r, ErrInvalid)
			return
		}
		result, e = h.service.Cancel(r.Context(), actor, client, parts[2], p.Revision)
	default:
		h.fail(w, r, ErrMissing)
		return
	}
	if e != nil {
		h.fail(w, r, e)
		return
	}
	h.data(w, r, status, result)
}
func (h *Handler) data(w http.ResponseWriter, r *http.Request, status int, data any) {
	httpapi.WriteJSON(w, r, status, struct {
		Data any `json:"data"`
	}{data})
}
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, e error) {
	status, code, message := 500, "internal_error", "An internal error occurred."
	switch {
	case errors.Is(e, ErrInvalid):
		status, code, message = 400, "invalid_request", "Billing input or pagination is invalid."
	case errors.Is(e, ErrMissing):
		status, code, message = 404, "not_found", "Collection or client not found."
	case errors.Is(e, ErrConflict):
		status, code, message = 409, "conflict", "The collection changed, the command was already used, or its financial lifecycle prevents this write. Reload current data before trying again."
	}
	if status == 500 {
		h.logger.ErrorContext(r.Context(), "billing_error", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
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
func parseFilter(r *http.Request, payments bool) (Filter, error) {
	f := Filter{Limit: 25, Status: "all"}
	q, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return f, ErrInvalid
	}
	for key, values := range q {
		if len(values) != 1 || values[0] == "" {
			return f, ErrInvalid
		}
		v := values[0]
		switch key {
		case "limit":
			f.Limit, e = strconv.Atoi(v)
			if e != nil {
				return f, ErrInvalid
			}
		case "cursor":
			f.Cursor = v
		case "status":
			if payments {
				return f, ErrInvalid
			}
			f.Status = v
		case "currency":
			if payments {
				return f, ErrInvalid
			}
			f.Currency = v
		case "search":
			if payments {
				return f, ErrInvalid
			}
			f.Search = strings.TrimSpace(v)
		default:
			return f, ErrInvalid
		}
	}
	if !validFilter(f) {
		return f, ErrInvalid
	}
	return f, nil
}
