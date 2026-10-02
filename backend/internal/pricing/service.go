package pricing

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
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
func databaseError(e error) error {
	var p *pgconn.PgError
	if errors.As(e, &p) {
		switch p.Code {
		case "P0002":
			return ErrMissing
		case "P0001", "23505":
			return ErrConflict
		case "22023", "22003", "22007", "22008", "23514":
			return ErrInvalid
		}
	}
	return e
}
func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func scope(actor, client string) bool { return validID(actor) && validID(client) }
func validPage(cursor string, limit int) bool {
	return limit >= 1 && limit <= 100 && (cursor == "" || validID(cursor))
}
func read[T any](ctx context.Context, s *Service, query string, args ...any) (T, error) {
	var item T
	var raw []byte
	if e := s.pool.QueryRow(ctx, query, args...).Scan(&raw); e != nil {
		return item, databaseError(e)
	}
	if len(raw) == 0 {
		return item, ErrMissing
	}
	e := json.Unmarshal(raw, &item)
	return item, e
}
func page[T any](rows pgx.Rows, limit int, id func(T) string) (Page[T], error) {
	defer rows.Close()
	p := Page[T]{Data: []T{}, Page: Pagination{Limit: limit}}
	for rows.Next() {
		var raw []byte
		var item T
		if e := rows.Scan(&raw); e != nil {
			return p, e
		}
		if e := json.Unmarshal(raw, &item); e != nil {
			return p, e
		}
		p.Data = append(p.Data, item)
	}
	if e := rows.Err(); e != nil {
		return p, databaseError(e)
	}
	if len(p.Data) > limit {
		v := id(p.Data[limit-1])
		p.Page.NextCursor = &v
		p.Data = p.Data[:limit]
	}
	return p, nil
}
func (s *Service) List(ctx context.Context, actor, client, cursor string, limit int) (Page[Sheet], error) {
	if !scope(actor, client) || !validPage(cursor, limit) {
		return Page[Sheet]{}, ErrInvalid
	}
	rows, e := s.pool.Query(ctx, `SELECT * FROM app.pricing_list($1::uuid,$2::uuid,NULL,$3::uuid,$4)`, actor, client, nullable(cursor), limit+1)
	if e != nil {
		return Page[Sheet]{}, databaseError(e)
	}
	return page(rows, limit, func(v Sheet) string { return v.ID })
}
func (s *Service) Detail(ctx context.Context, actor, client, target string) (Sheet, error) {
	if !scope(actor, client) || !validID(target) {
		return Sheet{}, ErrInvalid
	}
	return read[Sheet](ctx, s, `SELECT app.pricing_read($1::uuid,$2::uuid,$3::uuid,NULL)`, actor, client, target)
}
func (s *Service) Versions(ctx context.Context, actor, client, target, cursor string, limit int) (Page[Version], error) {
	if !scope(actor, client) || !validID(target) || !validPage(cursor, limit) {
		return Page[Version]{}, ErrInvalid
	}
	rows, e := s.pool.Query(ctx, `SELECT * FROM app.pricing_list($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5)`, actor, client, target, nullable(cursor), limit+1)
	if e != nil {
		return Page[Version]{}, databaseError(e)
	}
	return page(rows, limit, func(v Version) string { return v.ID })
}
func (s *Service) Version(ctx context.Context, actor, client, target, version string) (Version, error) {
	if !scope(actor, client) || !validID(target) || !validID(version) {
		return Version{}, ErrInvalid
	}
	return read[Version](ctx, s, `SELECT app.pricing_read($1::uuid,$2::uuid,$3::uuid,$4::uuid)`, actor, client, target, version)
}
func (s *Service) Preview(ctx context.Context, actor, client string, p Profile) (Calculation, error) {
	if !scope(actor, client) {
		return Calculation{}, ErrInvalid
	}
	p, e := normalize(p)
	if e != nil {
		return Calculation{}, e
	}
	raw, e := json.Marshal(p)
	if e != nil {
		return Calculation{}, ErrInvalid
	}
	return read[Calculation](ctx, s, `SELECT app.pricing_preview($1::uuid,$2::uuid,$3::jsonb)`, actor, client, raw)
}
func (s *Service) Create(ctx context.Context, actor, client string, p Profile) (Mutation, error) {
	id, e := newID()
	if e != nil {
		return Mutation{}, e
	}
	return s.write(ctx, actor, client, id, 0, p)
}
func (s *Service) Append(ctx context.Context, actor, client, target, revision string, p Profile) (Mutation, error) {
	expected, e := integer(revision, true)
	if e != nil || expected == math.MaxInt64 {
		return Mutation{}, ErrInvalid
	}
	return s.write(ctx, actor, client, target, expected, p)
}
func (s *Service) write(ctx context.Context, actor, client, target string, expected int64, p Profile) (Mutation, error) {
	if !scope(actor, client) || !validID(target) {
		return Mutation{}, ErrInvalid
	}
	p, e := normalize(p)
	if e != nil {
		return Mutation{}, e
	}
	version, e := newID()
	if e != nil {
		return Mutation{}, e
	}
	raw, e := json.Marshal(p)
	if e != nil {
		return Mutation{}, ErrInvalid
	}
	result := Mutation{ID: strings.ToLower(target), VersionID: version}
	e = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var code string
		var before, after []byte
		var rev int64
		if e := q.QueryRow(ctx, `SELECT * FROM app.pricing_write($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb)`, actor, client, target, version, expected, raw).Scan(&code, &before, &after, &rev); e != nil {
			return audit.Event{}, e
		}
		if code != "ok" {
			return audit.Event{}, ErrInvalid
		}
		result.Revision = strconv.FormatInt(rev, 10)
		action := audit.Updated
		if expected == 0 {
			action = audit.Created
		}
		return event(actor, client, target, "pricing", action, before, after)
	})
	if e != nil {
		return Mutation{}, databaseError(e)
	}
	return result, nil
}
func event(actor, client, target, kind string, action audit.Action, before, after []byte) (audit.Event, error) {
	var previous, current *audit.Snapshot
	if e := json.Unmarshal(before, &previous); e != nil {
		return audit.Event{}, ErrInvalid
	}
	if e := json.Unmarshal(after, &current); e != nil || current == nil {
		return audit.Event{}, ErrInvalid
	}
	return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, Action: action, ResourceKind: kind, ResourceID: target, ClientID: client, Before: previous, After: current, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
}
func (s *Service) Copy(ctx context.Context, actor, client, target, version, revision string, p CopyInput) (CollectionMutation, error) {
	if !scope(actor, client) || !validID(target) || !validID(version) {
		return CollectionMutation{}, ErrInvalid
	}
	expected, e := integer(revision, true)
	if e != nil {
		return CollectionMutation{}, e
	}
	p, e = normalizeCopy(p)
	if e != nil {
		return CollectionMutation{}, e
	}
	id, e := newID()
	if e != nil {
		return CollectionMutation{}, e
	}
	raw, e := json.Marshal(p)
	if e != nil {
		return CollectionMutation{}, ErrInvalid
	}
	var result CollectionMutation
	e = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var code string
		var before, after []byte
		var rev int64
		if e := q.QueryRow(ctx, `SELECT * FROM app.pricing_copy($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb,$7::uuid)`, actor, client, target, version, expected, raw, id).Scan(&code, &before, &after, &result.ID, &rev); e != nil {
			return audit.Event{}, e
		}
		result.Revision = strconv.FormatInt(rev, 10)
		result.Replayed = code == "replay"
		if result.Replayed {
			return audit.Event{}, errReplay
		}
		if code != "ok" {
			return audit.Event{}, ErrInvalid
		}
		return event(actor, client, result.ID, "billing", audit.Created, before, after)
	})
	if errors.Is(e, errReplay) {
		return result, nil
	}
	if e != nil {
		return CollectionMutation{}, databaseError(e)
	}
	return result, nil
}
func (s *Service) Snapshot(ctx context.Context, actor, client, collection string) (Snapshot, error) {
	if !scope(actor, client) || !validID(collection) {
		return Snapshot{}, ErrInvalid
	}
	return read[Snapshot](ctx, s, `SELECT app.pricing_snapshot_read($1::uuid,$2::uuid,$3::uuid)`, actor, client, collection)
}
