package billing

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
func readRows[T any](rows pgx.Rows) ([]T, error) {
	defer rows.Close()
	result := []T{}
	for rows.Next() {
		var raw []byte
		var item T
		if e := rows.Scan(&raw); e != nil {
			return nil, e
		}
		if e := json.Unmarshal(raw, &item); e != nil {
			return nil, e
		}
		result = append(result, item)
	}
	return result, databaseError(rows.Err())
}
func page[T any](rows pgx.Rows, limit int, id func(T) string) (Page[T], error) {
	items, e := readRows[T](rows)
	p := Page[T]{Data: items, Page: Pagination{Limit: limit}}
	if e != nil {
		return p, e
	}
	if len(items) > limit {
		last := id(items[limit-1])
		p.Page.NextCursor = &last
		p.Data = items[:limit]
	}
	return p, nil
}
func (s *Service) List(ctx context.Context, actor, client string, f Filter) (Page[Collection], error) {
	if !scope(actor, client) || !validFilter(f) {
		return Page[Collection]{}, ErrInvalid
	}
	rows, e := s.pool.Query(ctx, `SELECT * FROM app.billing_list($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7)`, actor, client, nullable(f.Cursor), f.Limit+1, f.Status, f.Currency, f.Search)
	if e != nil {
		return Page[Collection]{}, databaseError(e)
	}
	return page(rows, f.Limit, func(v Collection) string { return v.ID })
}
func (s *Service) Detail(ctx context.Context, actor, client, target string) (Collection, error) {
	var c Collection
	if !scope(actor, client) || !validID(target) {
		return c, ErrInvalid
	}
	var raw []byte
	if e := s.pool.QueryRow(ctx, `SELECT app.billing_read($1::uuid,$2::uuid,$3::uuid)`, actor, client, target).Scan(&raw); e != nil {
		return c, databaseError(e)
	}
	if len(raw) == 0 {
		return c, ErrMissing
	}
	e := json.Unmarshal(raw, &c)
	return c, e
}
func (s *Service) Payments(ctx context.Context, actor, client, target, cursor string, limit int) (Page[Payment], error) {
	if !scope(actor, client) || !validID(target) || cursor != "" && !validID(cursor) || limit < 1 || limit > 100 {
		return Page[Payment]{}, ErrInvalid
	}
	rows, e := s.pool.Query(ctx, `SELECT * FROM app.billing_payments($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5)`, actor, client, target, nullable(cursor), limit+1)
	if e != nil {
		return Page[Payment]{}, databaseError(e)
	}
	return page(rows, limit, func(v Payment) string { return v.ID })
}
func (s *Service) Summary(ctx context.Context, actor, client string) ([]Totals, error) {
	if !scope(actor, client) {
		return nil, ErrInvalid
	}
	rows, e := s.pool.Query(ctx, `SELECT * FROM app.billing_summary($1::uuid,$2::uuid)`, actor, client)
	if e != nil {
		return nil, databaseError(e)
	}
	return readRows[Totals](rows)
}
func (s *Service) Currencies(ctx context.Context, actor, client string) ([]Currency, error) {
	if !scope(actor, client) {
		return nil, ErrInvalid
	}
	rows, e := s.pool.Query(ctx, `SELECT * FROM app.billing_currency_list($1::uuid,$2::uuid)`, actor, client)
	if e != nil {
		return nil, databaseError(e)
	}
	return readRows[Currency](rows)
}
func (s *Service) Create(ctx context.Context, actor, client string, p Profile) (Mutation, error) {
	p, e := normalize(p)
	if e != nil {
		return Mutation{}, e
	}
	id, e := newID()
	if e != nil {
		return Mutation{}, e
	}
	return s.write(ctx, actor, client, id, "0", "create", p)
}
func (s *Service) Update(ctx context.Context, actor, client, target, revision string, p Profile) (Mutation, error) {
	p, e := normalize(p)
	if e != nil {
		return Mutation{}, e
	}
	return s.write(ctx, actor, client, target, revision, "update", p)
}
func (s *Service) Cancel(ctx context.Context, actor, client, target, revision string) (Mutation, error) {
	return s.write(ctx, actor, client, target, revision, "cancel", nil)
}
func (s *Service) RecordPayment(ctx context.Context, actor, client, target, revision string, p PaymentInput) (Mutation, error) {
	p, e := normalizePayment(p)
	if e != nil {
		return Mutation{}, e
	}
	return s.write(ctx, actor, client, target, revision, "payment", p)
}
func (s *Service) write(ctx context.Context, actor, client, target, revision, operation string, input any) (Mutation, error) {
	if !scope(actor, client) || !validID(target) {
		return Mutation{}, ErrInvalid
	}
	expected := int64(0)
	var e error
	if operation != "create" {
		expected, e = integer(revision)
		if e != nil || expected == math.MaxInt64 {
			return Mutation{}, ErrInvalid
		}
	}
	raw, e := json.Marshal(input)
	if e != nil {
		return Mutation{}, ErrInvalid
	}
	paymentID, e := newID()
	if e != nil {
		return Mutation{}, e
	}
	result := Mutation{ID: strings.ToLower(target)}
	e = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var code string
		var previous, current []byte
		var payment *string
		var rev int64
		if err := q.QueryRow(ctx, `SELECT * FROM app.billing_write($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7::uuid)`, actor, client, target, expected, operation, raw, paymentID).Scan(&code, &previous, &current, &payment, &rev); err != nil {
			return audit.Event{}, err
		}
		switch code {
		case "ok", "replay":
		case "missing":
			return audit.Event{}, ErrMissing
		case "conflict":
			return audit.Event{}, ErrConflict
		default:
			return audit.Event{}, ErrInvalid
		}
		result.Revision = strconv.FormatInt(rev, 10)
		result.PaymentID = payment
		result.Replayed = code == "replay"
		if result.Replayed {
			return audit.Event{}, errReplay
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
		case "payment":
			action = audit.PaymentRecorded
		case "cancel":
			action = audit.Cancelled
		}
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, Action: action, ResourceKind: "billing", ResourceID: target, ClientID: client, Before: before, After: after, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
	if errors.Is(e, errReplay) {
		return result, nil
	}
	if e != nil {
		return Mutation{}, databaseError(e)
	}
	return result, nil
}
