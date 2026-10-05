package clients

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"

	httpapi "github.com/theroisey/else/backend/internal/http"
)

// Reuse the original authenticated provider handlers after an explicit website
// ownership check; never relax their own authorization or validation.
func (h *Handler) WithWebsiteProviders(provider http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/clients/"), "/")
		if len(parts) >= 2 && parts[1] == "websites" {
			h.serveWebsite(w, r, parts, provider)
			return
		}
		h.ServeHTTP(w, r)
	})
}
func (h *Handler) serveWebsite(w http.ResponseWriter, r *http.Request, parts []string, provider http.Handler) {
	w.Header().Set("Cache-Control", "no-store")
	session, ok := h.auth.AuthenticateRequest(w, r)
	if !ok {
		return
	}
	if len(parts) < 2 || !validID(parts[0]) || (len(parts) > 2 && !validID(parts[2])) {
		h.fail(w, r, ErrInvalid)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost && r.Method != http.MethodPut && r.Method != http.MethodPatch {
		w.Header().Set("Allow", "GET, POST, PUT, PATCH")
		httpapi.WriteError(w, r, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	if r.Method != http.MethodGet && !h.auth.VerifyMutation(w, r, session) {
		return
	}
	actor, client := session.User.ID, parts[0]
	if len(parts) >= 5 && (parts[3] == "analytics" || parts[3] == "commerce" || parts[3] == "marketing" || parts[3] == "integrations") && validID(parts[4]) && provider != nil {
		var allowed bool
		if err := h.service.pool.QueryRow(r.Context(), `SELECT app.website_connection_allowed($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::boolean)`, actor, client, parts[2], parts[4], r.Method != http.MethodGet).Scan(&allowed); err != nil {
			h.fail(w, r, websiteError(err))
			return
		}
		if !allowed {
			h.fail(w, r, ErrMissing)
			return
		}
		cloned := r.Clone(r.Context())
		copied := *r.URL
		cloned.URL = &copied
		cloned.URL.Path = "/api/v1/clients/" + client + "/" + strings.Join(parts[3:], "/")
		cloned.URL.RawPath = ""
		provider.ServeHTTP(w, cloned)
		return
	}
	if r.Method == http.MethodGet {
		if len(parts) == 2 {
			limit, cursor, state, err := websiteFilter(r, true)
			if err != nil {
				h.fail(w, r, err)
				return
			}
			page, err := h.service.Websites(r.Context(), actor, client, cursor, state, limit)
			if err != nil {
				h.fail(w, r, err)
				return
			}
			httpapi.WriteJSON(w, r, 200, page)
			return
		}
		if len(parts) == 3 {
			if r.URL.RawQuery != "" {
				h.fail(w, r, ErrInvalid)
				return
			}
			item, err := h.service.Website(r.Context(), actor, client, parts[2])
			if err != nil {
				h.fail(w, r, err)
				return
			}
			h.data(w, r, 200, item)
			return
		}
		if len(parts) == 4 && (parts[3] == "connections" || parts[3] == "activity") {
			limit, cursor, _, err := websiteFilter(r, false)
			if err != nil {
				h.fail(w, r, err)
				return
			}
			read := h.service.WebsiteConnections
			if parts[3] == "activity" {
				read = h.service.WebsiteActivity
			}
			items, next, err := read(r.Context(), actor, client, parts[2], cursor, limit)
			if err != nil {
				h.fail(w, r, err)
				return
			}
			httpapi.WriteJSON(w, r, 200, struct {
				Data any `json:"data"`
				Page any `json:"page"`
			}{items, struct {
				Limit int     `json:"limit"`
				Next  *string `json:"next_cursor"`
			}{limit, next}})
			return
		}
	} else {
		if r.URL.RawQuery != "" {
			h.fail(w, r, ErrInvalid)
			return
		}
		if len(parts) == 2 && r.Method == http.MethodPost {
			var p WebsiteProfile
			if !decode(w, r, &p) {
				return
			}
			item, err := h.service.WriteWebsite(r.Context(), actor, client, "", 0, "create", p)
			if err != nil {
				h.fail(w, r, err)
				return
			}
			h.data(w, r, 201, item)
			return
		}
		if len(parts) == 3 && (r.Method == http.MethodPut || r.Method == http.MethodPatch) {
			var p struct {
				WebsiteProfile
				Revision int64 `json:"expected_revision"`
			}
			if !decode(w, r, &p) {
				return
			}
			item, err := h.service.WriteWebsite(r.Context(), actor, client, parts[2], p.Revision, "update", p.WebsiteProfile)
			if err != nil {
				h.fail(w, r, err)
				return
			}
			h.data(w, r, 200, item)
			return
		}
		if len(parts) == 4 && r.Method == http.MethodPost && (parts[3] == "archive" || parts[3] == "primary") {
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
			item, err := h.service.WriteWebsite(r.Context(), actor, client, parts[2], p.Revision, parts[3], WebsiteProfile{})
			if err != nil {
				h.fail(w, r, err)
				return
			}
			h.data(w, r, 200, item)
			return
		}
		if len(parts) == 4 && parts[3] == "connections" && r.Method == http.MethodPost {
			var p struct {
				Revision   int64  `json:"expected_revision"`
				Connection string `json:"connection_id"`
				Attach     bool   `json:"attach"`
				Confirm    bool   `json:"confirm"`
			}
			if !decode(w, r, &p) {
				return
			}
			if !p.Confirm {
				h.fail(w, r, ErrInvalid)
				return
			}
			item, err := h.service.BindWebsiteConnection(r.Context(), actor, client, parts[2], p.Connection, p.Revision, p.Attach)
			if err != nil {
				h.fail(w, r, err)
				return
			}
			h.data(w, r, 200, item)
			return
		}
	}
	h.fail(w, r, ErrMissing)
}
func websiteFilter(r *http.Request, stateAllowed bool) (int, string, string, error) {
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return 0, "", "", err
	}
	limit := 25
	state := "active"
	cursor := ""
	for key, values := range q {
		if len(values) != 1 || values[0] == "" {
			return 0, "", "", ErrInvalid
		}
		switch key {
		case "limit":
			limit, err = strconv.Atoi(values[0])
		case "cursor":
			cursor = values[0]
		case "status":
			if !stateAllowed {
				return 0, "", "", ErrInvalid
			}
			state = values[0]
		default:
			return 0, "", "", ErrInvalid
		}
		if err != nil {
			return 0, "", "", ErrInvalid
		}
	}
	if limit < 1 || limit > 100 || (cursor != "" && !validID(cursor)) || (state != "active" && state != "archived" && state != "all") {
		return 0, "", "", ErrInvalid
	}
	return limit, cursor, state, nil
}
