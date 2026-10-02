package reminders

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"

	"github.com/jackc/pgx/v5"
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
		case "P0002", "42501":
			return ErrMissing
		case "P0001", "23505":
			return ErrConflict
		case "22023":
			return ErrInvalid
		}
	}
	return err
}
func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func readPage[T any](rows pgx.Rows, limit int, id func(T) string) (Page[T], error) {
	p := Page[T]{Data: []T{}, Page: Pagination{Limit: limit}}
	defer rows.Close()
	var last string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return p, err
		}
		if len(p.Data) == limit {
			p.Page.NextCursor = &last
			break
		}
		var item T
		if err := json.Unmarshal(raw, &item); err != nil || !validID(id(item)) {
			return p, ErrInvalid
		}
		last = id(item)
		p.Data = append(p.Data, item)
	}
	return p, databaseError(rows.Err())
}
func (s *Service) List(ctx context.Context, actor, client string, f Filter) (Page[Summary], error) {
	if !validID(actor) || !validID(client) || !validFilter(f) {
		return Page[Summary]{}, ErrInvalid
	}
	owner := f.Owner
	if owner == "me" {
		owner = actor
	}
	if owner == "any" {
		owner = ""
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.reminder_list($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8,$9)`, actor, client, nullable(f.Cursor), f.Limit+1, f.Status, f.Due, nullable(owner), f.Search, f.Sort == "-id")
	if err != nil {
		return Page[Summary]{}, databaseError(err)
	}
	return readPage(rows, f.Limit, func(v Summary) string { return v.ID })
}
func (s *Service) Owners(ctx context.Context, actor, client, cursor string, limit int) (Page[Owner], error) {
	if !validID(actor) || !validID(client) || (cursor != "" && !validID(cursor)) || limit < 1 || limit > 100 {
		return Page[Owner]{}, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.reminder_owners($1::uuid,$2::uuid,$3::uuid,$4)`, actor, client, nullable(cursor), limit+1)
	if err != nil {
		return Page[Owner]{}, databaseError(err)
	}
	return readPage(rows, limit, func(v Owner) string { return v.ID })
}
func (s *Service) Detail(ctx context.Context, actor, client, target string) (Record, error) {
	var r Record
	if !validID(actor) || !validID(client) || !validID(target) {
		return r, ErrInvalid
	}
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT app.reminder_read($1::uuid,$2::uuid,$3::uuid)`, actor, client, target).Scan(&raw); err != nil {
		return r, databaseError(err)
	}
	if len(raw) == 0 {
		return r, ErrMissing
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return r, ErrInvalid
	}
	return r, nil
}
func (s *Service) Create(ctx context.Context, actor, client string, p Profile) (Mutation, error) {
	if p.OwnerID == "" {
		p.OwnerID = actor
	}
	v, err := normalize(p)
	if err != nil {
		return Mutation{}, err
	}
	id, err := newID()
	if err != nil {
		return Mutation{}, err
	}
	return s.write(ctx, actor, client, id, 0, "create", v)
}
func (s *Service) Update(ctx context.Context, actor, client, target string, revision int64, p Profile) (Mutation, error) {
	v, err := normalize(p)
	if err != nil {
		return Mutation{}, err
	}
	return s.write(ctx, actor, client, target, revision, "update", v)
}
func (s *Service) Complete(ctx context.Context, actor, client, target string, revision int64) (Mutation, error) {
	return s.write(ctx, actor, client, target, revision, "complete", validatedProfile{})
}
func (s *Service) Dismiss(ctx context.Context, actor, client, target string, revision int64) (Mutation, error) {
	return s.write(ctx, actor, client, target, revision, "dismiss", validatedProfile{})
}

// The commit boundary is the future notification/outbox seam. This service has
// no delivery adapter and never treats a due schedule as notification success.
func (s *Service) write(ctx context.Context, actor, client, target string, revision int64, operation string, p validatedProfile) (Mutation, error) {
	if !validID(actor) || !validID(client) || !validID(target) || (operation != "create" && (revision < 1 || revision == math.MaxInt64)) {
		return Mutation{}, ErrInvalid
	}
	target = strings.ToLower(target)
	raw, err := json.Marshal(p)
	if err != nil {
		return Mutation{}, ErrInvalid
	}
	err = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var code string
		var previous, current []byte
		if err := q.QueryRow(ctx, `SELECT * FROM app.reminder_write($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb)`, actor, client, target, revision, operation, raw).Scan(&code, &previous, &current); err != nil {
			return audit.Event{}, err
		}
		switch code {
		case "ok":
		case "missing":
			return audit.Event{}, ErrMissing
		case "conflict":
			return audit.Event{}, ErrConflict
		case "invalid_owner":
			return audit.Event{}, ErrOwner
		case "invalid_resource":
			return audit.Event{}, ErrResource
		case "invalid_schedule":
			return audit.Event{}, ErrSchedule
		default:
			return audit.Event{}, ErrInvalid
		}
		var before, after *audit.Snapshot
		if err := json.Unmarshal(previous, &before); err != nil {
			return audit.Event{}, ErrInvalid
		}
		if err := json.Unmarshal(current, &after); err != nil || after == nil {
			return audit.Event{}, ErrInvalid
		}
		action := audit.Updated
		switch operation {
		case "create":
			action = audit.Created
		case "complete":
			action = audit.Completed
		case "dismiss":
			action = audit.Dismissed
		}
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, Action: action, ResourceKind: "reminder", ResourceID: target, ClientID: client, Before: before, After: after, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
	if err != nil {
		return Mutation{}, databaseError(err)
	}
	return Mutation{ID: target, Revision: revision + 1}, nil
}
