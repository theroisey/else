package clients

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/theroisey/else/backend/internal/audit"
)

type WebsiteProfile struct {
	Name        string `json:"name"`
	URL         string `json:"url"`
	Domain      string `json:"domain"`
	Description string `json:"description"`
}
type Website struct {
	WebsiteProfile
	ID          string     `json:"id"`
	ClientID    string     `json:"client_id"`
	Status      string     `json:"status"`
	IsPrimary   bool       `json:"is_primary"`
	NeedsReview bool       `json:"needs_review"`
	Revision    int64      `json:"revision"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	ArchivedAt  *time.Time `json:"archived_at"`
}
type WebsitePage struct {
	Data []Website `json:"data"`
	Page struct {
		Limit      int     `json:"limit"`
		NextCursor *string `json:"next_cursor"`
	} `json:"page"`
}

// URLs are identifiers, never fetched here. Provider adapters retain separate
// destination/SSRF protections. Preserve meaningful paths and all subdomains.
func normalizeWebsite(p WebsiteProfile) (WebsiteProfile, error) {
	if !validText(p.URL, 2048, true) {
		return WebsiteProfile{}, ErrInvalid
	}
	p.Name = strings.TrimSpace(p.Name)
	p.URL = strings.TrimSpace(p.URL)
	p.Description = strings.TrimSpace(p.Description)
	if !strings.Contains(p.URL, "://") {
		p.URL = "https://" + p.URL
	}
	u, err := url.Parse(p.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Fragment != "" || u.RawQuery != "" || u.ForceQuery || !validText(p.URL, 2048, true) || !validText(p.Name, 200, true) || !validText(p.Description, 4000, false) {
		return WebsiteProfile{}, ErrInvalid
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if len(host) > 253 || len(host) < 3 || !strings.Contains(host, ".") || net.ParseIP(host) != nil {
		return WebsiteProfile{}, ErrInvalid
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) < 1 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return WebsiteProfile{}, ErrInvalid
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
				return WebsiteProfile{}, ErrInvalid
			}
		}
	}
	// Punycode DNS labels are supported; Unicode hostnames must be supplied in
	// their ASCII IDNA form, avoiding a new network/URL normalization dependency.
	port := u.Port()
	if port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return WebsiteProfile{}, ErrInvalid
		}
		u.Host = net.JoinHostPort(host, port)
	} else {
		u.Host = host
	}
	if u.Path == "/" {
		u.Path = ""
		u.RawPath = ""
	}
	p.URL = u.String()
	p.Domain = host
	return p, nil
}
func websiteError(err error) error {
	var e *pgconn.PgError
	if errors.As(err, &e) {
		switch e.Code {
		case "P0002", "42501":
			return ErrMissing
		case "22023":
			return ErrInvalid
		case "23505":
			return ErrConflict
		}
	}
	return err
}
func (s *Service) Websites(ctx context.Context, actor, client, cursor, state string, limit int) (WebsitePage, error) {
	page := WebsitePage{Data: []Website{}}
	page.Page.Limit = limit
	if !validID(actor) || !validID(client) || (cursor != "" && !validID(cursor)) || limit < 1 || limit > 100 || (state != "active" && state != "archived" && state != "all") {
		return page, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.website_list($1::uuid,$2::uuid,$3::uuid,$4,$5)`, actor, client, nullable(cursor), limit+1, state)
	if err != nil {
		return page, websiteError(err)
	}
	defer rows.Close()
	var last string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return page, err
		}
		if len(page.Data) == limit {
			page.Page.NextCursor = &last
			break
		}
		var item Website
		if err := json.Unmarshal(raw, &item); err != nil {
			return page, err
		}
		last = item.ID
		page.Data = append(page.Data, item)
	}
	return page, websiteError(rows.Err())
}
func (s *Service) Website(ctx context.Context, actor, client, id string) (Website, error) {
	var item Website
	if !validID(actor) || !validID(client) || !validID(id) {
		return item, ErrInvalid
	}
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT app.website_read($1::uuid,$2::uuid,$3::uuid)`, actor, client, id).Scan(&raw); err != nil {
		return item, websiteError(err)
	}
	if len(raw) == 0 {
		return item, ErrMissing
	}
	err := json.Unmarshal(raw, &item)
	return item, err
}
func (s *Service) WriteWebsite(ctx context.Context, actor, client, id string, revision int64, operation string, profile WebsiteProfile) (Mutation, error) {
	if !validID(actor) || !validID(client) || revision < 0 || revision >= 9223372036854775807 {
		return Mutation{}, ErrInvalid
	}
	if operation == "create" {
		var err error
		id, err = newID()
		if err != nil {
			return Mutation{}, err
		}
	} else if !validID(id) {
		return Mutation{}, ErrInvalid
	}
	if operation == "create" || operation == "update" {
		var err error
		profile, err = normalizeWebsite(profile)
		if err != nil {
			return Mutation{}, err
		}
	}
	raw, err := json.Marshal(profile)
	if err != nil {
		return Mutation{}, err
	}
	err = audit.WithTransactionEvents(ctx, s.pool, func(ctx context.Context, q audit.Queries) ([]audit.Event, error) {
		var result []byte
		if err := q.QueryRow(ctx, `SELECT app.website_write($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb)`, actor, client, id, revision, operation, raw).Scan(&result); err != nil {
			return nil, err
		}
		var reply struct {
			Code    string `json:"code"`
			Changes []struct {
				ID     string       `json:"id"`
				Before int64        `json:"before"`
				After  int64        `json:"after"`
				Action audit.Action `json:"action"`
			} `json:"changes"`
		}
		if err := json.Unmarshal(result, &reply); err != nil {
			return nil, err
		}
		if err := websiteCode(reply.Code); err != nil {
			return nil, err
		}
		events := []audit.Event{}
		exists := true
		for _, change := range reply.Changes {
			var before *audit.Snapshot
			if change.Before > 0 {
				before = &audit.Snapshot{Exists: &exists, Revision: &change.Before}
			}
			events = append(events, audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, ResourceKind: "website", ResourceID: change.ID, ClientID: client, Action: change.Action, Before: before, After: &audit.Snapshot{Exists: &exists, Revision: &change.After}, Metadata: audit.Metadata{Source: audit.HTTP}})
		}
		return events, nil
	})
	if err != nil {
		return Mutation{}, websiteError(err)
	}
	return Mutation{ID: id, Revision: revision + 1}, nil
}
func websiteCode(code string) error {
	switch code {
	case "ok":
		return nil
	case "missing":
		return ErrMissing
	case "conflict":
		return ErrConflict
	default:
		return ErrInvalid
	}
}
func (s *Service) WebsiteConnections(ctx context.Context, actor, client, website, cursor string, limit int) ([]json.RawMessage, *string, error) {
	if !validID(actor) || !validID(client) || !validID(website) || (cursor != "" && !validID(cursor)) || limit < 1 || limit > 100 {
		return nil, nil, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.website_connections($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5)`, actor, client, website, nullable(cursor), limit+1)
	if err != nil {
		return nil, nil, websiteError(err)
	}
	defer rows.Close()
	items := []json.RawMessage{}
	var last string
	var next *string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, nil, err
		}
		if len(items) == limit {
			next = &last
			break
		}
		var item struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &item); err != nil {
			return nil, nil, err
		}
		last = item.ID
		items = append(items, raw)
	}
	return items, next, websiteError(rows.Err())
}
func (s *Service) BindWebsiteConnection(ctx context.Context, actor, client, website, connection string, revision int64, attach bool) (Mutation, error) {
	if !validID(actor) || !validID(client) || !validID(website) || !validID(connection) || revision < 1 || revision >= 9223372036854775807 {
		return Mutation{}, ErrInvalid
	}
	err := audit.WithTransactionEvents(ctx, s.pool, func(ctx context.Context, q audit.Queries) ([]audit.Event, error) {
		var code string
		if err := q.QueryRow(ctx, `SELECT app.website_connection_binding($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6)`, actor, client, website, connection, revision, attach).Scan(&code); err != nil {
			return nil, err
		}
		if err := websiteCode(code); err != nil {
			return nil, err
		}
		exists := true
		next := revision + 1
		event := audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, Action: audit.Updated, ResourceKind: "website", ResourceID: website, ClientID: client, Before: &audit.Snapshot{Exists: &exists, Revision: &revision}, After: &audit.Snapshot{Exists: &exists, Revision: &next}, Metadata: audit.Metadata{Source: audit.HTTP}}
		before := !attach
		after := attach
		action := audit.Created
		if !attach {
			action = audit.Deleted
		}
		relation := audit.Event{Actor: event.Actor, Action: action, ResourceKind: "website_integration", ResourceID: connection, ClientID: client, Before: &audit.Snapshot{Exists: &before}, After: &audit.Snapshot{Exists: &after}, Metadata: event.Metadata}
		return []audit.Event{event, relation}, nil
	})
	if err != nil {
		return Mutation{}, websiteError(err)
	}
	return Mutation{ID: website, Revision: revision + 1}, nil
}

func (s *Service) WebsiteActivity(ctx context.Context, actor, client, website, cursor string, limit int) ([]json.RawMessage, *string, error) {
	if !validID(actor) || !validID(client) || !validID(website) || (cursor != "" && !validID(cursor)) || limit < 1 || limit > 100 {
		return nil, nil, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.website_activity($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5)`, actor, client, website, nullable(cursor), limit+1)
	if err != nil {
		return nil, nil, websiteError(err)
	}
	defer rows.Close()
	items := []json.RawMessage{}
	var last string
	var next *string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, nil, err
		}
		if len(items) == limit {
			next = &last
			break
		}
		var item struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &item); err != nil {
			return nil, nil, err
		}
		last = item.ID
		items = append(items, raw)
	}
	return items, next, websiteError(rows.Err())
}
