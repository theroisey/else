package analytics

import (
	"encoding/json"
	"net/http"
	"net/url"

	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
)

func (h *Handler) serveCommerce(w http.ResponseWriter, r *http.Request, session identity.Session, parts []string) {
	if len(parts) < 2 || !validID(parts[0]) {
		h.fail(w, r, ErrInvalid)
		return
	}
	if parts[1] == "commerce" {
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
			page, err := h.service.ListCommerce(r.Context(), session.User.ID, parts[0], query.Get("after"))
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
		parts = []string{parts[0], "integrations", parts[2], "woocommerce"}
	}
	if len(parts) == 4 && parts[3] == "woocommerce" && validID(parts[2]) {
		if r.Method != http.MethodGet {
			h.method(w, r, "GET")
			return
		}
		period, err := commercePeriodQuery(r.URL)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		view, err := h.service.ReadCommerce(r.Context(), session.User.ID, parts[0], parts[2], period.start, period.end, period.currency)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		httpapi.WriteJSON(w, r, 200, view)
		return
	}
	create := len(parts) == 3 && parts[2] == "woocommerce"
	setup := len(parts) == 5 && validID(parts[2]) && parts[3] == "woocommerce" && parts[4] == "credentials"
	sync := len(parts) == 5 && validID(parts[2]) && parts[3] == "woocommerce" && parts[4] == "sync"
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
	allowed := []string{"revision", "start", "end", "currency"}
	if create {
		allowed = []string{"origin"}
	} else if setup {
		allowed = append(allowed, "consumer_key", "consumer_secret")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	fields, err := decodeFields(r.Body, allowed)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if create {
		connection, err := h.service.CreateCommerce(r.Context(), session.User.ID, parts[0], fields["origin"])
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
	if setup {
		plaintext, marshalErr := json.Marshal(map[string]string{"consumer_key": fields["consumer_key"], "consumer_secret": fields["consumer_secret"]})
		delete(fields, "consumer_key")
		delete(fields, "consumer_secret")
		defer clear(plaintext)
		if marshalErr != nil {
			h.fail(w, r, ErrInvalid)
			return
		}
		queued, err = h.service.SetupCommerce(r.Context(), session.User.ID, parts[0], parts[2], fields["revision"], fields["start"], fields["end"], fields["currency"], plaintext)
	} else {
		queued, err = h.service.EnqueueCommerce(r.Context(), session.User.ID, parts[0], parts[2], fields["revision"], fields["start"], fields["end"], fields["currency"])
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpapi.WriteJSON(w, r, 202, queued)
}

func commercePeriodQuery(u *url.URL) (syncPeriod, error) {
	if u == nil || u.ForceQuery || len(u.RawQuery) > 200 {
		return syncPeriod{}, ErrInvalid
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(query) != 3 || len(query["start"]) != 1 || len(query["end"]) != 1 || len(query["currency"]) != 1 {
		return syncPeriod{}, ErrInvalid
	}
	period := syncPeriod{provider: "woocommerce", start: query.Get("start"), end: query.Get("end"), currency: query.Get("currency")}
	if !period.valid("a1000000-0000-4000-8000-000000000001", "a2000000-0000-4000-8000-000000000001") {
		return syncPeriod{}, ErrInvalid
	}
	return period, nil
}
