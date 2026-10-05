package identity

import (
	"context"
	"net/http"

	"github.com/theroisey/else/backend/internal/audit"
	httpapi "github.com/theroisey/else/backend/internal/http"
)

func (h *Handler) preferences(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	session, ok := h.AuthenticateRequest(w, r)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		httpapi.WriteError(w, r, 400, "invalid_request", "Request is invalid.")
		return
	}
	switch r.Method {
	case http.MethodGet:
		var locale *string
		if err := h.service.pool.QueryRow(r.Context(), `SELECT app.user_locale_read($1::uuid)`, session.User.ID).Scan(&locale); err != nil {
			httpapi.WriteError(w, r, 500, "internal_error", "Unable to load preferences.")
			return
		}
		httpapi.WriteJSON(w, r, 200, struct {
			Data any `json:"data"`
		}{struct {
			Locale *string `json:"locale"`
		}{locale}})
	case http.MethodPut:
		if !h.VerifyMutation(w, r, session) {
			return
		}
		var input struct {
			Locale string `json:"locale"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		switch input.Locale {
		case "en", "tr", "ro", "de", "fr":
		default:
			httpapi.WriteError(w, r, 400, "invalid_request", "Language is invalid.")
			return
		}
		err := audit.WithTransaction(r.Context(), h.service.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
			var next int64
			if err := q.QueryRow(ctx, `SELECT app.user_locale_write($1::uuid,$2)`, session.User.ID, input.Locale).Scan(&next); err != nil {
				return audit.Event{}, err
			}
			exists := true
			action := audit.Created
			var before *audit.Snapshot
			if next > 1 {
				previous := next - 1
				action = audit.Updated
				before = &audit.Snapshot{Exists: &exists, Revision: &previous}
			}
			return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: session.User.ID}, ResourceKind: "user_preference", ResourceID: session.User.ID, Action: action, Before: before, After: &audit.Snapshot{Exists: &exists, Revision: &next}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
		})
		if err != nil {
			httpapi.WriteError(w, r, 500, "internal_error", "Unable to save preferences.")
			return
		}
		httpapi.WriteJSON(w, r, 200, struct {
			Data any `json:"data"`
		}{struct {
			Locale string `json:"locale"`
		}{input.Locale}})
	default:
		w.Header().Set("Allow", "GET, PUT")
		httpapi.WriteError(w, r, 405, "method_not_allowed", "Method not allowed.")
	}
}
