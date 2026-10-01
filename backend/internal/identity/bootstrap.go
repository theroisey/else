package identity

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/authorization"
)

var ErrAlreadyInitialized = errors.New("identity bootstrap already completed")

func Bootstrap(ctx context.Context, pool *pgxpool.Pool, passwords Passwords, email, displayName, password string) (string, error) {
	canonical, ok := canonicalEmail(email)
	if pool == nil || passwords == nil || !ok || !validDisplayName(displayName) || !validPassword(password) {
		return "", ErrInvalidInput
	}
	hash, err := passwords.Hash(password)
	if err != nil {
		return "", err
	}
	id, err := newID()
	if err != nil {
		return "", err
	}
	assignmentID, err := newID()
	if err != nil {
		return "", err
	}
	err = audit.WithTransactionEvents(ctx, pool, func(ctx context.Context, q audit.Queries) ([]audit.Event, error) {
		if _, err := q.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", int64(871092650208)); err != nil {
			return nil, err
		}
		var count int
		if err := q.QueryRow(ctx, "SELECT count(*) FROM app.users").Scan(&count); err != nil {
			return nil, err
		}
		if count != 0 {
			return nil, ErrAlreadyInitialized
		}
		_, err := q.Exec(ctx, `INSERT INTO app.users (id,email,display_name,password_hash,status,bootstrap_admin) VALUES ($1::uuid,$2,$3,$4,'active',true)`, id, canonical, displayName, hash)
		if err != nil {
			return nil, err
		}
		if _, err := q.Exec(ctx, `INSERT INTO app.user_roles (id,user_id,role_id,scope_kind) VALUES ($1::uuid,$2::uuid,$3::uuid,'global')`, assignmentID, id, authorization.InitialAdministratorRoleID); err != nil {
			return nil, err
		}
		exists := true
		return []audit.Event{
			{Actor: audit.Actor{Kind: audit.System}, Action: audit.Created, ResourceKind: "user", ResourceID: id, After: &audit.Snapshot{Exists: &exists}, Metadata: audit.Metadata{Source: audit.CLI}},
			{Actor: audit.Actor{Kind: audit.System}, Action: audit.Created, ResourceKind: "role_assignment", ResourceID: assignmentID, After: &audit.Snapshot{Exists: &exists}, Metadata: audit.Metadata{Source: audit.CLI}},
		}, nil
	})
	if err != nil {
		return "", err
	}
	return id, nil
}
