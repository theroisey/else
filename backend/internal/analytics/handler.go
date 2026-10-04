package analytics

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
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

// WithMetadata keeps the existing list/detail/disconnect handler and adds only
// the reviewed provider routes. Each path authenticates the current session.
func (h *Handler) WithMetadata(metadata http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/clients/"), "/")
		if strings.HasPrefix(r.URL.Path, "/api/v1/clients/") && len(parts) >= 2 && (parts[1] == "analytics" || parts[1] == "commerce" || parts[1] == "marketing") {
			h.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/clients/") && len(parts) >= 3 && parts[1] == "integrations" && ((len(parts) == 3 && (parts[2] == "ga4" || parts[2] == "woocommerce" || parts[2] == "meta_ads")) || (len(parts) >= 4 && (parts[3] == "ga4" || parts[3] == "woocommerce" || parts[3] == "meta_ads"))) {
			h.ServeHTTP(w, r)
			return
		}
		metadata.ServeHTTP(w, r)
	})
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	session, ok := h.auth.AuthenticateRequest(w, r)
	if !ok {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/clients/"), "/")
	if strings.HasPrefix(r.URL.Path, "/api/v1/clients/") && len(parts) >= 2 && (parts[1] == "commerce" || (parts[1] == "integrations" && ((len(parts) == 3 && parts[2] == "woocommerce") || (len(parts) >= 4 && parts[3] == "woocommerce")))) {
		h.serveCommerce(w, r, session, parts)
		return
	}
	dateProvider := "ga4"
	if len(parts) >= 2 && (parts[1] == "marketing" || parts[1] == "integrations" && ((len(parts) == 3 && parts[2] == "meta_ads") || len(parts) >= 4 && parts[3] == "meta_ads")) {
		dateProvider = "meta_ads"
	}
	if strings.HasPrefix(r.URL.Path, "/api/v1/clients/") && len(parts) >= 2 && (parts[1] == "analytics" || parts[1] == "marketing") && validID(parts[0]) {
		if r.Method != http.MethodGet {
			h.method(w, r, "GET")
			return
		}
		if len(parts) == 2 {
			query, err := url.ParseQuery(r.URL.RawQuery)
			if err != nil || r.URL.ForceQuery || len(r.URL.RawQuery) > 80 || len(query) > 1 || (len(query) == 1 && len(query["after"]) != 1) {
				h.fail(w, r, ErrInvalid)
				return
			}
			page, err := h.service.list(r.Context(), session.User.ID, parts[0], query.Get("after"), dateProvider)
			if err != nil {
				h.fail(w, r, err)
				return
			}
			httpapi.WriteJSON(w, r, 200, page)
			return
		}
		if len(parts) != 3 || !validID(parts[2]) {
			h.fail(w, r, ErrInvalid)
			return
		}
		// The canonical analytics read uses the same protected report operation.
		parts = append([]string{parts[0], "integrations", parts[2]}, dateProvider)
	}
	if !strings.HasPrefix(r.URL.Path, "/api/v1/clients/") || len(parts) < 3 || parts[1] != "integrations" || !validID(parts[0]) {
		h.fail(w, r, ErrInvalid)
		return
	}
	if len(parts) == 4 && parts[3] == dateProvider && validID(parts[2]) {
		if r.Method != http.MethodGet {
			h.method(w, r, "GET")
			return
		}
		since, until, err := periodQuery(r.URL)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		var view any
		if dateProvider == "meta_ads" {
			view, err = h.service.ReadMarketing(r.Context(), session.User.ID, parts[0], parts[2], since, until)
		} else {
			view, err = h.service.Read(r.Context(), session.User.ID, parts[0], parts[2], since, until)
		}
		if err != nil {
			h.fail(w, r, err)
			return
		}
		httpapi.WriteJSON(w, r, 200, view)
		return
	}
	create := len(parts) == 3 && parts[2] == dateProvider
	setup := len(parts) == 5 && validID(parts[2]) && parts[3] == dateProvider && parts[4] == "credentials"
	sync := len(parts) == 5 && validID(parts[2]) && parts[3] == dateProvider && parts[4] == "sync"
	if !create && !setup && !sync {
		h.fail(w, r, ErrInvalid)
		return
	}
	if r.Method != http.MethodPost {
		h.method(w, r, "POST")
		return
	}
	if !h.auth.VerifyMutation(w, r, session) {
		return
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		h.fail(w, r, ErrInvalid)
		return
	}
	allowed := []string{"revision", "since", "until"}
	accountField, credentialField, bodyLimit := "property_id", "credential_json", int64(32<<10)
	if dateProvider == "meta_ads" {
		accountField, credentialField, bodyLimit = "account_id", "access_token", 8<<10
	}
	if create {
		allowed = []string{accountField}
	} else if setup {
		allowed = append(allowed, credentialField)
	}
	r.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
	fields, err := decodeFields(r.Body, allowed)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if create {
		connection, err := h.service.create(r.Context(), session.User.ID, parts[0], dateProvider, fields[accountField])
		if err != nil {
			h.fail(w, r, err)
			return
		}
		httpapi.WriteJSON(w, r, 201, struct {
			Data any `json:"data"`
		}{connection})
		return
	}
	var queued Queued
	period := syncPeriod{provider: dateProvider, since: fields["since"], until: fields["until"]}
	if setup {
		plaintext := []byte(fields[credentialField])
		delete(fields, credentialField)
		defer clear(plaintext)
		queued, err = h.service.setup(r.Context(), session.User.ID, parts[0], parts[2], fields["revision"], period, plaintext)
	} else {
		queued, err = h.service.enqueue(r.Context(), session.User.ID, parts[0], parts[2], fields["revision"], period)
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpapi.WriteJSON(w, r, 202, queued)
}

func decodeFields(reader io.Reader, allowed []string) (map[string]string, error) {
	d := json.NewDecoder(reader)
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return nil, ErrInvalid
	}
	fields := make(map[string]string, len(allowed))
	for d.More() {
		token, err := d.Token()
		name, ok := token.(string)
		if err != nil || !ok {
			return nil, ErrInvalid
		}
		if _, duplicate := fields[name]; duplicate {
			return nil, ErrInvalid
		}
		known := false
		for _, candidate := range allowed {
			known = known || name == candidate
		}
		var value string
		if !known || d.Decode(&value) != nil || value == "" {
			return nil, ErrInvalid
		}
		fields[name] = value
	}
	if token, err := d.Token(); err != nil || token != json.Delim('}') || len(fields) != len(allowed) {
		return nil, ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, ErrInvalid
	}
	return fields, nil
}

func periodQuery(u *url.URL) (string, string, error) {
	if u == nil || u.ForceQuery || len(u.RawQuery) > 128 {
		return "", "", ErrInvalid
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(query) != 2 || len(query["since"]) != 1 || len(query["until"]) != 1 || !validPeriod(query.Get("since"), query.Get("until")) {
		return "", "", ErrInvalid
	}
	return query.Get("since"), query.Get("until"), nil
}

func (h *Handler) method(w http.ResponseWriter, r *http.Request, allow string) {
	w.Header().Set("Allow", allow)
	httpapi.WriteError(w, r, 405, "method_not_allowed", "Method not allowed.")
}

func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, message := 503, "unavailable", "Analytics is temporarily unavailable."
	switch {
	case errors.Is(err, ErrInvalid):
		status, code, message = 400, "invalid_request", "Analytics request is invalid."
	case errors.Is(err, ErrMissing):
		status, code, message = 404, "not_found", "Analytics or client not found."
	case errors.Is(err, ErrConflict):
		status, code, message = 409, "conflict", "The integration changed or synchronization is already active. Reload current data before trying again."
	}
	if status == 503 {
		h.logger.ErrorContext(r.Context(), "analytics_unavailable", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
	}
	httpapi.WriteError(w, r, status, code, message)
}
