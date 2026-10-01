package administration

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/identity"
)

type Service struct {
	pool      *pgxpool.Pool
	passwords identity.Passwords
}

func NewService(pool *pgxpool.Pool, passwords identity.Passwords) (*Service, error) {
	if pool == nil || passwords == nil {
		return nil, ErrInvalid
	}
	return &Service{pool: pool, passwords: passwords}, nil
}

func databaseError(err error) error {
	var failure *pgconn.PgError
	if errors.As(err, &failure) {
		switch failure.Code {
		case "P1001":
			return ErrLastAdministrator
		case "42501":
			return ErrDenied
		case "23505":
			return ErrConflict
		}
	}
	return err
}
func outcome(code string) error {
	switch code {
	case "ok":
		return nil
	case "denied":
		return ErrDenied
	case "missing":
		return ErrMissing
	case "conflict":
		return ErrConflict
	case "self_disable":
		return ErrSelfDisable
	case "system_role":
		return ErrSystemRole
	default:
		return ErrInvalid
	}
}

func readPage[T any](ctx context.Context, pool *pgxpool.Pool, sql string, limit int, args ...any) (Page[T], error) {
	page := Page[T]{Data: make([]T, 0)}
	page.Page.Limit = limit
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return page, databaseError(err)
	}
	defer rows.Close()
	var lastID string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return page, err
		}
		if len(page.Data) == limit {
			page.Page.NextCursor = &lastID
			break
		}
		var item T
		var cursor struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &item); err != nil {
			return page, ErrInvalid
		}
		if err := json.Unmarshal(raw, &cursor); err != nil || !validID(cursor.ID) {
			return page, ErrInvalid
		}
		lastID = cursor.ID
		page.Data = append(page.Data, item)
	}
	return page, databaseError(rows.Err())
}
func (s *Service) Users(ctx context.Context, actor, cursor string, limit int) (Page[User], error) {
	if !validID(actor) || !validPage(cursor, limit) {
		return Page[User]{}, ErrInvalid
	}
	return readPage[User](ctx, s.pool, `SELECT * FROM app.admin_users($1::uuid,$2::uuid,$3)`, limit, actor, nullable(cursor), limit+1)
}
func (s *Service) Roles(ctx context.Context, actor, cursor string, limit int) (Page[Role], error) {
	if !validID(actor) || !validPage(cursor, limit) {
		return Page[Role]{}, ErrInvalid
	}
	return readPage[Role](ctx, s.pool, `SELECT * FROM app.admin_roles($1::uuid,$2::uuid,$3)`, limit, actor, nullable(cursor), limit+1)
}
func (s *Service) Assignments(ctx context.Context, actor, target, cursor string, limit int) (Page[Assignment], error) {
	if !validID(actor) || !validID(target) || !validPage(cursor, limit) {
		return Page[Assignment]{}, ErrInvalid
	}
	return readPage[Assignment](ctx, s.pool, `SELECT * FROM app.admin_assignments($1::uuid,$2::uuid,$3::uuid,$4)`, limit, actor, target, nullable(cursor), limit+1)
}
func readRecord[T any](ctx context.Context, pool *pgxpool.Pool, sql, actor, target string) (T, error) {
	var item T
	if !validID(actor) || !validID(target) {
		return item, ErrInvalid
	}
	var raw []byte
	if err := pool.QueryRow(ctx, sql, actor, target).Scan(&raw); err != nil {
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
func (s *Service) User(ctx context.Context, actor, target string) (User, error) {
	return readRecord[User](ctx, s.pool, `SELECT app.admin_user($1::uuid,$2::uuid)`, actor, target)
}
func (s *Service) Role(ctx context.Context, actor, target string) (Role, error) {
	return readRecord[Role](ctx, s.pool, `SELECT app.admin_role($1::uuid,$2::uuid)`, actor, target)
}
func (s *Service) Catalog(ctx context.Context, actor string) ([]Permission, error) {
	if !validID(actor) {
		return nil, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM app.admin_catalog($1::uuid)`, actor)
	if err != nil {
		return nil, databaseError(err)
	}
	defer rows.Close()
	permissions := make([]Permission, 0)
	for rows.Next() {
		var raw []byte
		var item Permission
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &item); err != nil {
			return nil, ErrInvalid
		}
		permissions = append(permissions, item)
	}
	return permissions, databaseError(rows.Err())
}

func marker(revision int64, status string) *audit.Snapshot {
	exists := true
	result := &audit.Snapshot{Exists: &exists, Revision: &revision}
	if status != "" {
		result.Status = &status
	}
	return result
}
func event(actor, kind, id string, action audit.Action, before, after *audit.Snapshot) audit.Event {
	return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, Action: action, ResourceKind: kind, ResourceID: id,
		Before: before, After: after, Metadata: audit.Metadata{Source: audit.HTTP}}
}
func (s *Service) CreateUser(ctx context.Context, actor, email, name, password string) (Mutation, error) {
	if !validID(actor) {
		return Mutation{}, ErrInvalid
	}
	email, name, err := normalizeProfile(email, name)
	if err != nil {
		return Mutation{}, err
	}
	// Hashing uses the identity policy, never a caller-supplied hash.
	hash, err := s.passwords.Hash(password)
	if err != nil {
		if errors.Is(err, identity.ErrInvalidInput) {
			return Mutation{}, ErrInvalid
		}
		return Mutation{}, err
	}
	id, err := newID()
	if err != nil {
		return Mutation{}, err
	}
	err = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var code string
		if err := q.QueryRow(ctx, `SELECT app.admin_create_user($1::uuid,$2::uuid,$3,$4,$5)`, actor, id, email, name, hash).Scan(&code); err != nil {
			return audit.Event{}, err
		}
		if err := outcome(code); err != nil {
			return audit.Event{}, err
		}
		return event(actor, "user", id, audit.Created, nil, marker(1, "active")), nil
	})
	return Mutation{ID: id, Revision: 1}, databaseError(err)
}
func (s *Service) UpdateUser(ctx context.Context, actor, target string, revision int64, email, name string) (Mutation, error) {
	if !validID(actor) || !validID(target) || revision < 1 {
		return Mutation{}, ErrInvalid
	}
	email, name, err := normalizeProfile(email, name)
	if err != nil {
		return Mutation{}, err
	}
	return s.changeUser(ctx, actor, target, revision, false, email, name)
}
func (s *Service) DisableUser(ctx context.Context, actor, target string, revision int64) (Mutation, error) {
	if !validID(actor) || !validID(target) || revision < 1 {
		return Mutation{}, ErrInvalid
	}
	return s.changeUser(ctx, actor, target, revision, true, "", "")
}
func (s *Service) changeUser(ctx context.Context, actor, target string, revision int64, disable bool, email, name string) (Mutation, error) {
	err := audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		sql := `SELECT outcome,old_revision,old_status FROM app.admin_update_user($1::uuid,$2::uuid,$3,$4,$5)`
		args := []any{actor, target, revision, email, name}
		if disable {
			sql = `SELECT outcome,old_revision,old_status FROM app.admin_disable_user($1::uuid,$2::uuid,$3)`
			args = args[:3]
		}
		var code string
		var oldRevision *int64
		var oldStatus *string
		if err := q.QueryRow(ctx, sql, args...).Scan(&code, &oldRevision, &oldStatus); err != nil {
			return audit.Event{}, err
		}
		if err := outcome(code); err != nil {
			return audit.Event{}, err
		}
		if oldRevision == nil || oldStatus == nil {
			return audit.Event{}, ErrInvalid
		}
		action, status := audit.Updated, *oldStatus
		if disable {
			action, status = audit.Disabled, "disabled"
		}
		return event(actor, "user", target, action, marker(*oldRevision, *oldStatus), marker(*oldRevision+1, status)), nil
	})
	return Mutation{ID: target, Revision: revision + 1}, databaseError(err)
}
func (s *Service) CreateRole(ctx context.Context, actor, name string, permissions []authorization.Permission) (Mutation, error) {
	name = strings.TrimSpace(name)
	if !validID(actor) || !validName(name) || !validPermissions(permissions) {
		return Mutation{}, ErrInvalid
	}
	id, err := newID()
	if err != nil {
		return Mutation{}, err
	}
	err = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var code string
		if err := q.QueryRow(ctx, `SELECT app.admin_create_role($1::uuid,$2::uuid,$3,$4::text[])`, actor, id, name, permissionStrings(permissions)).Scan(&code); err != nil {
			return audit.Event{}, err
		}
		if err := outcome(code); err != nil {
			return audit.Event{}, err
		}
		return event(actor, "role", id, audit.Created, nil, marker(1, "")), nil
	})
	return Mutation{ID: id, Revision: 1}, databaseError(err)
}
func (s *Service) ReplacePermissions(ctx context.Context, actor, target string, revision int64, permissions []authorization.Permission) (Mutation, error) {
	if !validID(actor) || !validID(target) || revision < 1 || !validPermissions(permissions) {
		return Mutation{}, ErrInvalid
	}
	err := audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var code string
		var oldRevision *int64
		if err := q.QueryRow(ctx, `SELECT outcome,old_revision FROM app.admin_replace_permissions($1::uuid,$2::uuid,$3,$4::text[])`, actor, target, revision, permissionStrings(permissions)).Scan(&code, &oldRevision); err != nil {
			return audit.Event{}, err
		}
		if err := outcome(code); err != nil {
			return audit.Event{}, err
		}
		if oldRevision == nil {
			return audit.Event{}, ErrInvalid
		}
		return event(actor, "role", target, audit.PermissionChanged, marker(*oldRevision, ""), marker(*oldRevision+1, "")), nil
	})
	return Mutation{ID: target, Revision: revision + 1}, databaseError(err)
}
func (s *Service) RevokeAssignment(ctx context.Context, actor, target, assignment string) error {
	if !validID(actor) || !validID(target) || !validID(assignment) {
		return ErrInvalid
	}
	err := audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var changed bool
		var client *string
		if err := q.QueryRow(ctx, `SELECT changed,client_id::text FROM app.admin_revoke_assignment($1::uuid,$2::uuid,$3::uuid,$4)`, actor, target, assignment, time.Now().UTC()).Scan(&changed, &client); err != nil {
			return audit.Event{}, err
		}
		if !changed {
			return audit.Event{}, ErrDenied
		}
		exists := false
		result := event(actor, "role_assignment", assignment, audit.Archived, nil, &audit.Snapshot{Exists: &exists})
		if client != nil {
			result.ClientID = *client
		}
		return result, nil
	})
	return databaseError(err)
}
func permissionStrings(permissions []authorization.Permission) []string {
	values := make([]string, len(permissions))
	for i, p := range permissions {
		values[i] = string(p)
	}
	return values
}
