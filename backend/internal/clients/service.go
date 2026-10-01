package clients

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/audit"
)

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) (*Service, error) {
	if pool == nil {
		return nil, ErrInvalid
	}
	return &Service{pool}, nil
}
func databaseError(err error) error {
	var p *pgconn.PgError
	if errors.As(err, &p) {
		switch p.Code {
		case "42501":
			return ErrDenied
		case "23505":
			return ErrConflict
		}
	}
	return err
}
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (s *Service) List(ctx context.Context, actor string, f Filter) (Page, error) {
	page := Page{Data: []Summary{}}
	page.Page.Limit = f.Limit
	if !validID(actor) || !validFilter(f) {
		return page, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.client_list($1::uuid,$2::uuid,$3,$4,$5,$6,$7)`, actor, nullable(f.Cursor), f.Limit+1, f.Status, f.Search, f.Tag, f.Sort == "-id")
	if err != nil {
		return page, databaseError(err)
	}
	defer rows.Close()
	var last string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return page, err
		}
		if len(page.Data) == f.Limit {
			page.Page.NextCursor = &last
			break
		}
		var item Summary
		if err := json.Unmarshal(raw, &item); err != nil || !validID(item.ID) {
			return page, ErrInvalid
		}
		last = item.ID
		page.Data = append(page.Data, item)
	}
	return page, databaseError(rows.Err())
}
func (s *Service) Detail(ctx context.Context, actor, target string) (Client, error) {
	var item Client
	if !validID(actor) || !validID(target) {
		return item, ErrInvalid
	}
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT app.client_read($1::uuid,$2::uuid)`, actor, target).Scan(&raw); err != nil {
		return item, databaseError(err)
	}
	if len(raw) == 0 {
		return item, ErrMissing
	}
	if err := json.Unmarshal(raw, &item); err != nil {
		return item, ErrInvalid
	}
	return item, nil
}
func (s *Service) Create(ctx context.Context, actor string, p Profile) (Mutation, error) {
	if !validID(actor) {
		return Mutation{}, ErrInvalid
	}
	p, err := normalize(p)
	if err != nil {
		return Mutation{}, err
	}
	id, err := newID()
	if err != nil {
		return Mutation{}, err
	}
	return s.write(ctx, actor, id, 0, p, false)
}
func (s *Service) Update(ctx context.Context, actor, target string, revision int64, p Profile) (Mutation, error) {
	if !validID(actor) || !validID(target) || revision < 1 {
		return Mutation{}, ErrInvalid
	}
	p, err := normalize(p)
	if err != nil {
		return Mutation{}, err
	}
	return s.write(ctx, actor, target, revision, p, false)
}
func (s *Service) Archive(ctx context.Context, actor, target string, revision int64) (Mutation, error) {
	if !validID(actor) || !validID(target) || revision < 1 {
		return Mutation{}, ErrInvalid
	}
	return s.write(ctx, actor, target, revision, Profile{}, true)
}
func (s *Service) write(ctx context.Context, actor, target string, revision int64, p Profile, archive bool) (Mutation, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return Mutation{}, ErrInvalid
	}
	err = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var code string
		if err := q.QueryRow(ctx, `SELECT app.client_write($1::uuid,$2::uuid,$3,$4::jsonb,$5)`, actor, target, revision, raw, archive).Scan(&code); err != nil {
			return audit.Event{}, err
		}
		switch code {
		case "ok":
		case "missing":
			return audit.Event{}, ErrMissing
		case "denied":
			return audit.Event{}, ErrDenied
		case "conflict":
			return audit.Event{}, ErrConflict
		default:
			return audit.Event{}, ErrInvalid
		}
		exists := true
		next := revision + 1
		action := audit.Updated
		var before *audit.Snapshot
		if revision == 0 {
			action = audit.Created
		} else {
			before = &audit.Snapshot{Exists: &exists, Revision: &revision}
		}
		if archive {
			action = audit.Archived
		}
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, Action: action, ResourceKind: "client", ResourceID: target, ClientID: target, Before: before, After: &audit.Snapshot{Exists: &exists, Revision: &next}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
	if err != nil {
		return Mutation{}, databaseError(err)
	}
	return Mutation{ID: target, Revision: revision + 1}, nil
}
