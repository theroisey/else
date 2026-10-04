package metaads

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"time"

	"github.com/theroisey/else/backend/internal/integrations/providerhttp"
)

type Request struct{ ClientID, ConnectionID, AccountID, Since, Until string }

func ValidRequest(r Request) bool {
	return validExpectation(Expectation{ClientID: r.ClientID, ConnectionID: r.ConnectionID, AccountID: r.AccountID,
		Since: r.Since, Until: r.Until, Currency: "USD", Timezone: "UTC"})
}

type Workspace struct {
	Report           Report    `json:"report"`
	CollectedFrom    time.Time `json:"collected_from"`
	CollectedThrough time.Time `json:"collected_through"`
}

type Adapter struct {
	client *providerhttp.Client
	// Package-private isolated contract fixtures never replace production origin.
	get func(context.Context, string, string, url.Values) ([]byte, error)
	now func() time.Time
}

func NewAdapter(admission *providerhttp.Admission) (*Adapter, error) {
	client, err := providerhttp.New("https://graph.facebook.com", admission)
	if err != nil {
		return nil, ErrInvalid
	}
	return &Adapter{client: client, now: time.Now}, nil
}

func (a *Adapter) request(ctx context.Context, path, authorization string, query url.Values, fence func(context.Context) error) ([]byte, error) {
	if ctx.Err() != nil || fence(ctx) != nil {
		return nil, ErrInvalid
	}
	if a.get != nil {
		return a.get(ctx, path, authorization, query)
	}
	return a.client.Do(ctx, "GET", path, query, nil, authorization, "")
}

var permissionName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,127}$`)

func readPermission(raw []byte) bool {
	page, ok := object(raw, "data", "paging")
	if !ok || page["data"] == nil || page["data"][0] != '[' {
		return false
	}
	next, _, ok := pagination(page["paging"])
	if !ok || next {
		return false
	}
	var rows []json.RawMessage
	if json.Unmarshal(page["data"], &rows) != nil || len(rows) > 100 {
		return false
	}
	seen, granted := map[string]bool{}, false
	for _, row := range rows {
		fields, ok := object(row, "permission", "status")
		if !ok || len(fields) != 2 {
			return false
		}
		var name, status string
		if json.Unmarshal(fields["permission"], &name) != nil || json.Unmarshal(fields["status"], &status) != nil ||
			!permissionName.MatchString(name) || seen[name] || (status != "granted" && status != "declined" && status != "expired") {
			return false
		}
		seen[name] = true
		granted = granted || name == "ads_read" && status == "granted"
	}
	return granted
}

func accountExpectation(raw []byte, r Request) (Expectation, bool) {
	fields, ok := object(raw, "id", "account_id", "currency", "timezone_name")
	if !ok || len(fields) != 4 {
		return Expectation{}, false
	}
	values := map[string]string{}
	for key, value := range fields {
		var text string
		if json.Unmarshal(value, &text) != nil {
			return Expectation{}, false
		}
		values[key] = text
	}
	e := Expectation{ClientID: r.ClientID, ConnectionID: r.ConnectionID, AccountID: r.AccountID,
		Since: r.Since, Until: r.Until, Currency: values["currency"], Timezone: values["timezone_name"]}
	return e, values["id"] == "act_"+r.AccountID && values["account_id"] == r.AccountID && validExpectation(e)
}

// FetchFenced performs only compiled GETs. Permission, immutable account identity
// and account-local currency/timezone are checked before and after collection.
// Provider links are observations, never destinations. Ordinary failure has no
// automatic retry and returns no partial report.
func (a *Adapter) FetchFenced(ctx context.Context, token *ReadToken, r Request, fence func(context.Context) error) (Workspace, error) {
	if a == nil || a.client == nil || a.now == nil || ctx == nil || ctx.Err() != nil || fence == nil || !ValidRequest(r) {
		return Workspace{}, ErrInvalid
	}
	authorization, ok := token.authorization()
	if !ok {
		return Workspace{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	from := a.now().UTC().Truncate(time.Microsecond)
	permissions := url.Values{"fields": {"permission,status"}, "limit": {"100"}}
	raw, err := a.request(ctx, "/"+GraphVersion+"/me/permissions", authorization, permissions, fence)
	if err != nil || len(raw) > maxPageBytes || !readPermission(raw) {
		return Workspace{}, ErrInvalid
	}
	accountPath := "/" + GraphVersion + "/act_" + r.AccountID
	accountQuery := url.Values{"fields": {"id,account_id,currency,timezone_name"}}
	raw, err = a.request(ctx, accountPath, authorization, accountQuery, fence)
	if err != nil || len(raw) > maxPageBytes {
		return Workspace{}, ErrInvalid
	}
	e, ok := accountExpectation(raw, r)
	if !ok {
		return Workspace{}, ErrInvalid
	}
	period, _ := json.Marshal(struct {
		Since string `json:"since"`
		Until string `json:"until"`
	}{r.Since, r.Until})
	query := url.Values{"fields": {"account_id,account_currency,date_start,date_stop,spend,impressions,clicks"},
		"level": {"account"}, "time_increment": {"1"}, "time_range": {string(period)}, "limit": {"31"}}
	var pages [][]byte
	seen := map[string]bool{}
	for i := 0; i < 4; i++ {
		body, err := a.request(ctx, accountPath+"/insights", authorization, query, fence)
		if err != nil || len(body) > maxPageBytes {
			return Workspace{}, ErrInvalid
		}
		page, ok := object(body, "data", "paging")
		if !ok {
			return Workspace{}, ErrInvalid
		}
		next, cursor, ok := pagination(page["paging"])
		if !ok || next && (cursor == "" || seen[cursor] || i == 3) {
			return Workspace{}, ErrInvalid
		}
		pages = append(pages, body)
		if !next {
			break
		}
		seen[cursor] = true
		query.Set("after", cursor)
	}
	report, err := Normalize(e, pages)
	if err != nil {
		return Workspace{}, ErrInvalid
	}
	query.Del("after")
	head, err := a.request(ctx, accountPath+"/insights", authorization, query, fence)
	if err != nil || !bytes.Equal(head, pages[0]) {
		return Workspace{}, ErrInvalid
	}
	raw, err = a.request(ctx, accountPath, authorization, accountQuery, fence)
	if err != nil || len(raw) > maxPageBytes {
		return Workspace{}, ErrInvalid
	}
	latest, ok := accountExpectation(raw, r)
	if !ok || latest != e {
		return Workspace{}, ErrInvalid
	}
	raw, err = a.request(ctx, "/"+GraphVersion+"/me/permissions", authorization, permissions, fence)
	if err != nil || len(raw) > maxPageBytes || !readPermission(raw) || ctx.Err() != nil || fence(ctx) != nil {
		return Workspace{}, ErrInvalid
	}
	value := Workspace{Report: report, CollectedFrom: from, CollectedThrough: a.now().UTC().Truncate(time.Microsecond)}
	if !ValidWorkspace(value, r) {
		return Workspace{}, ErrInvalid
	}
	return value, nil
}
