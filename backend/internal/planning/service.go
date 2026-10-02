package planning

import (
	"context"
	"encoding/json"
	"errors"
	"math"

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
func validScope(actor, client, parent string) bool {
	return validID(actor) && validID(client) && (parent == "" || validID(parent))
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
func (s *Service) List(ctx context.Context, actor, client, parent string, f Filter) (Page[Summary], error) {
	if !validScope(actor, client, parent) || !validFilter(f, parent != "") {
		return Page[Summary]{}, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.planning_list($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9)`, actor, client, nullable(parent), nullable(f.Cursor), f.Limit+1, f.Status, f.Search, f.Archived, f.Sort == "-id")
	if err != nil {
		return Page[Summary]{}, databaseError(err)
	}
	return readPage(rows, f.Limit, func(v Summary) string { return v.ID })
}
func (s *Service) Detail(ctx context.Context, actor, client, parent, target string) (Record, error) {
	var item Record
	if !validScope(actor, client, parent) || !validID(target) {
		return item, ErrInvalid
	}
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT app.planning_read($1::uuid,$2::uuid,$3::uuid,$4::uuid)`, actor, client, nullable(parent), target).Scan(&raw); err != nil {
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
func (s *Service) Links(ctx context.Context, actor, client, parent, target string, f Filter) (Page[Link], error) {
	if !validScope(actor, client, parent) || parent == "" || !validID(target) || !validFilter(f, true) || f.Status != "all" || f.Search != "" {
		return Page[Link]{}, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.planning_links($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8)`, actor, client, parent, target, nullable(f.Cursor), f.Limit+1, f.Archived, f.Sort == "-id")
	if err != nil {
		return Page[Link]{}, databaseError(err)
	}
	return readPage(rows, f.Limit, func(v Link) string { return v.ID })
}
func (s *Service) Candidates(ctx context.Context, actor, client, parent string, f Filter) (Page[Candidate], error) {
	if !validScope(actor, client, parent) || parent == "" || !validFilter(f, false) || f.Status != "all" || f.Archived != "false" {
		return Page[Candidate]{}, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.planning_task_candidates($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7)`, actor, client, parent, nullable(f.Cursor), f.Limit+1, f.Search, f.Sort == "-id")
	if err != nil {
		return Page[Candidate]{}, databaseError(err)
	}
	return readPage(rows, f.Limit, func(v Candidate) string { return v.ID })
}
func (s *Service) Create(ctx context.Context, actor, client, parent string, p Profile) (Mutation, error) {
	p, err := normalize(p, parent != "")
	if err != nil {
		return Mutation{}, err
	}
	target, err := newID()
	if err != nil {
		return Mutation{}, err
	}
	return s.write(ctx, actor, client, parent, target, 0, "create", p, "", nil)
}
func (s *Service) Update(ctx context.Context, actor, client, parent, target string, revision int64, p Profile) (Mutation, error) {
	p, err := normalize(p, parent != "")
	if err != nil {
		return Mutation{}, err
	}
	return s.write(ctx, actor, client, parent, target, revision, "update", p, "", nil)
}
func (s *Service) Transition(ctx context.Context, actor, client, parent, target string, revision int64, status string) (Mutation, error) {
	if !validState(status, parent != "") {
		return Mutation{}, ErrInvalid
	}
	return s.write(ctx, actor, client, parent, target, revision, "status", Profile{}, status, nil)
}
func (s *Service) Archive(ctx context.Context, actor, client, parent, target string, revision int64) (Mutation, error) {
	return s.write(ctx, actor, client, parent, target, revision, "archive", Profile{}, "", nil)
}
func (s *Service) ReplaceLinks(ctx context.Context, actor, client, parent, target string, revision int64, ids []string) (Mutation, error) {
	if parent == "" {
		return Mutation{}, ErrInvalid
	}
	ids, err := normalizedLinks(ids)
	if err != nil {
		return Mutation{}, err
	}
	return s.write(ctx, actor, client, parent, target, revision, "links", Profile{}, "", ids)
}
func (s *Service) write(ctx context.Context, actor, client, parent, target string, revision int64, operation string, p Profile, state string, links []string) (Mutation, error) {
	if !validScope(actor, client, parent) || !validID(target) || (operation != "create" && (revision < 1 || revision == math.MaxInt64)) {
		return Mutation{}, ErrInvalid
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return Mutation{}, ErrInvalid
	}
	linked, err := json.Marshal(links)
	if err != nil {
		return Mutation{}, ErrInvalid
	}
	err = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var code string
		var previous, current *string
		if err := q.QueryRow(ctx, `SELECT * FROM app.planning_write($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8,$9::jsonb)`, actor, client, nullable(parent), target, revision, operation, raw, state, linked).Scan(&code, &previous, &current); err != nil {
			return audit.Event{}, err
		}
		switch code {
		case "ok":
		case "missing":
			return audit.Event{}, ErrMissing
		case "conflict":
			return audit.Event{}, ErrConflict
		case "invalid_transition":
			return audit.Event{}, ErrTransition
		case "invalid_dates":
			return audit.Event{}, ErrDates
		case "invalid_link":
			return audit.Event{}, ErrLink
		default:
			return audit.Event{}, ErrInvalid
		}
		kind := "plan"
		if parent != "" {
			kind = "milestone"
		}
		exists := true
		next := revision + 1
		action := audit.Updated
		var before *audit.Snapshot
		if operation == "create" {
			action = audit.Created
		} else {
			before = &audit.Snapshot{Exists: &exists, Revision: &revision, PlanningStatus: previous}
		}
		if operation == "archive" {
			action = audit.Archived
		}
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, Action: action, ResourceKind: kind, ResourceID: target, ClientID: client, Before: before, After: &audit.Snapshot{Exists: &exists, Revision: &next, PlanningStatus: current}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
	if err != nil {
		return Mutation{}, databaseError(err)
	}
	return Mutation{ID: target, Revision: revision + 1}, nil
}
