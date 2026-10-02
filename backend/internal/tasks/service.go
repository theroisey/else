package tasks

import (
	"context"
	"encoding/json"
	"errors"

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
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func readPage[T any](rows pgx.Rows, limit int, id func(T) string) (Page[T], error) {
	page := Page[T]{Data: []T{}, Page: Pagination{Limit: limit}}
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
		var item T
		if err := json.Unmarshal(raw, &item); err != nil || !validID(id(item)) {
			return page, ErrInvalid
		}
		last = id(item)
		page.Data = append(page.Data, item)
	}
	return page, databaseError(rows.Err())
}
func (s *Service) List(ctx context.Context, actor, client string, f Filter) (Page[Summary], error) {
	if !validID(actor) || !validID(client) || !validFilter(f) {
		return Page[Summary]{}, ErrInvalid
	}
	assigned := f.Assignee
	if assigned == "unassigned" {
		assigned = ""
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.task_list($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8,$9,$10,$11,$12)`,
		actor, client, nullable(f.Cursor), f.Limit+1, f.Status, f.Priority, nullable(assigned), f.Assignee == "unassigned", f.Search, f.Tag, f.Archived, f.Sort == "-id")
	if err != nil {
		return Page[Summary]{}, databaseError(err)
	}
	return readPage(rows, f.Limit, func(v Summary) string { return v.ID })
}
func (s *Service) Assignees(ctx context.Context, actor, client, cursor string, limit int) (Page[Assignee], error) {
	if !validID(actor) || !validID(client) || (cursor != "" && !validID(cursor)) || limit < 1 || limit > 100 {
		return Page[Assignee]{}, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.task_assignees($1::uuid,$2::uuid,$3::uuid,$4)`, actor, client, nullable(cursor), limit+1)
	if err != nil {
		return Page[Assignee]{}, databaseError(err)
	}
	return readPage(rows, limit, func(v Assignee) string { return v.ID })
}
func (s *Service) Detail(ctx context.Context, actor, client, target string) (Task, error) {
	var item Task
	if !validID(actor) || !validID(client) || !validID(target) {
		return item, ErrInvalid
	}
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT app.task_read($1::uuid,$2::uuid,$3::uuid)`, actor, client, target).Scan(&raw); err != nil {
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
func (s *Service) Create(ctx context.Context, actor, client string, input CreateInput) (Mutation, error) {
	if !validID(actor) || !validID(client) {
		return Mutation{}, ErrInvalid
	}
	if input.Status == "" {
		input.Status = "todo"
	}
	if input.Status != "backlog" && input.Status != "todo" {
		return Mutation{}, ErrInvalid
	}
	p, err := normalize(input.Profile)
	if err != nil {
		return Mutation{}, err
	}
	id, err := newID()
	if err != nil {
		return Mutation{}, err
	}
	return s.write(ctx, actor, client, id, 0, "create", p, input.Status)
}
func (s *Service) Update(ctx context.Context, actor, client, target string, revision int64, p Profile) (Mutation, error) {
	p, err := normalize(p)
	if err != nil {
		return Mutation{}, err
	}
	return s.write(ctx, actor, client, target, revision, "update", p, "")
}
func (s *Service) Transition(ctx context.Context, actor, client, target string, revision int64, status string) (Mutation, error) {
	if !validStatus(status) {
		return Mutation{}, ErrInvalid
	}
	return s.write(ctx, actor, client, target, revision, "status", Profile{}, status)
}
func (s *Service) Archive(ctx context.Context, actor, client, target string, revision int64) (Mutation, error) {
	return s.write(ctx, actor, client, target, revision, "archive", Profile{}, "")
}
func (s *Service) write(ctx context.Context, actor, client, target string, revision int64, operation string, p Profile, status string) (Mutation, error) {
	if !validID(actor) || !validID(client) || !validID(target) || (operation != "create" && revision < 1) {
		return Mutation{}, ErrInvalid
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return Mutation{}, ErrInvalid
	}
	err = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var code string
		var previous, current *string
		if err := q.QueryRow(ctx, `SELECT * FROM app.task_write($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7)`, actor, client, target, revision, operation, raw, status).Scan(&code, &previous, &current); err != nil {
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
		case "invalid_assignee":
			return audit.Event{}, ErrAssignee
		default:
			return audit.Event{}, ErrInvalid
		}
		exists := true
		next := revision + 1
		action := audit.Updated
		var before *audit.Snapshot
		if operation == "create" {
			action = audit.Created
		} else {
			before = &audit.Snapshot{Exists: &exists, Revision: &revision, TaskStatus: previous}
		}
		if operation == "archive" {
			action = audit.Archived
		} else if operation == "status" && status == "done" {
			action = audit.Completed
		} else if operation == "status" && status == "cancelled" {
			action = audit.Cancelled
		}
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, Action: action, ResourceKind: "task", ResourceID: target, ClientID: client,
			Before: before, After: &audit.Snapshot{Exists: &exists, Revision: &next, TaskStatus: current}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
	if err != nil {
		return Mutation{}, databaseError(err)
	}
	return Mutation{ID: target, Revision: revision + 1}, nil
}
