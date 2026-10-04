package identity

import (
	"context"
	"crypto/subtle"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/authorization"
)

const SessionLifetime = 12 * time.Hour

type Service struct {
	pool      *pgxpool.Pool
	passwords Passwords
	dummyHash string
	now       func() time.Time
	grants    GrantReader
}

type GrantReader interface {
	Grants(context.Context, string) ([]authorization.Grant, error)
}

type User struct {
	ID          string                `json:"id"`
	Email       string                `json:"email"`
	DisplayName string                `json:"display_name"`
	Permissions []authorization.Grant `json:"permissions"`
}
type Session struct {
	ID        string
	User      User
	ExpiresAt time.Time
	csrfHash  [32]byte
}
type LoginResult struct {
	Session     Session
	Token, CSRF string
}

func NewService(pool *pgxpool.Pool, passwords Passwords, readers ...GrantReader) (*Service, error) {
	if pool == nil || passwords == nil {
		return nil, ErrInvalidInput
	}
	dummy, err := passwords.Hash("constant-dummy-password")
	if err != nil {
		return nil, err
	}
	var grants GrantReader
	if len(readers) > 1 {
		return nil, ErrInvalidInput
	}
	if len(readers) == 1 {
		grants = readers[0]
	}
	return &Service{pool: pool, passwords: passwords, dummyHash: dummy, now: time.Now, grants: grants}, nil
}

func (s *Service) Login(ctx context.Context, suppliedEmail, password string) (LoginResult, error) {
	email, validEmail := canonicalEmail(suppliedEmail)
	var user User
	var hash, status string
	err := s.pool.QueryRow(ctx, `SELECT id::text, email, display_name, password_hash, status FROM app.authentication_identity($1)`, email).
		Scan(&user.ID, &user.Email, &user.DisplayName, &hash, &status)
	found := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return LoginResult{}, err
	}
	verifyHash := hash
	if !found {
		verifyHash = s.dummyHash
	}
	verified, err := verifyPassword(ctx, s.passwords, verifyHash, password)
	if err != nil {
		return LoginResult{}, err
	}
	if !found || !validEmail || !validPassword(password) || !verified || status != "active" {
		return LoginResult{}, ErrInvalidCredentials
	}
	if err := s.loadGrants(ctx, &user); err != nil {
		return LoginResult{}, err
	}
	sessionID, err := newID()
	if err != nil {
		return LoginResult{}, err
	}
	token, tokenHash, err := randomSecret()
	if err != nil {
		return LoginResult{}, err
	}
	csrf, csrfHash, err := randomSecret()
	if err != nil {
		return LoginResult{}, err
	}
	now := s.now().UTC()
	result := LoginResult{Session: Session{ID: sessionID, User: user, ExpiresAt: now.Add(SessionLifetime), csrfHash: csrfHash}, Token: token, CSRF: csrf}
	err = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var currentHash, currentStatus string
		if err := q.QueryRow(ctx, `SELECT password_hash, status FROM app.lock_authentication_identity($1::uuid)`, user.ID).Scan(&currentHash, &currentStatus); err != nil {
			return audit.Event{}, err
		}
		if currentHash != hash || currentStatus != "active" {
			return audit.Event{}, ErrInvalidCredentials
		}
		if _, err := q.Exec(ctx, `INSERT INTO app.sessions (id,user_id,token_hash,csrf_hash,created_at,expires_at) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6)`, sessionID, user.ID, tokenHash[:], csrfHash[:], now, result.Session.ExpiresAt); err != nil {
			return audit.Event{}, err
		}
		if _, err := q.Exec(ctx, `UPDATE app.users SET last_login_at=$2, updated_at=$2 WHERE id=$1::uuid`, user.ID, now); err != nil {
			return audit.Event{}, err
		}
		exists := true
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: user.ID}, Action: audit.Created, ResourceKind: "session", ResourceID: sessionID, After: &audit.Snapshot{Exists: &exists}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
	if err != nil {
		return LoginResult{}, err
	}
	return result, nil
}

func (s *Service) Current(ctx context.Context, token string) (Session, error) {
	digest, ok := secretDigest(token)
	if !ok {
		return Session{}, ErrUnauthorized
	}
	now := s.now().UTC()
	var session Session
	var csrf []byte
	err := s.pool.QueryRow(ctx, `SELECT session_id::text,user_id::text,email,display_name,expires_at,csrf_hash
		FROM app.current_identity($1,$2)`, digest[:], now).
		Scan(&session.ID, &session.User.ID, &session.User.Email, &session.User.DisplayName, &session.ExpiresAt, &csrf)
	if err != nil || len(csrf) != 32 {
		return Session{}, ErrUnauthorized
	}
	copy(session.csrfHash[:], csrf)
	if err := s.loadGrants(ctx, &session.User); err != nil {
		return Session{}, err
	}
	return session, nil
}

func (s *Service) loadGrants(ctx context.Context, user *User) error {
	user.Permissions = make([]authorization.Grant, 0)
	if s.grants == nil {
		return nil
	}
	grants, err := s.grants.Grants(ctx, user.ID)
	if err != nil {
		return err
	}
	user.Permissions = grants
	return nil
}

func (s *Service) ValidCSRF(session Session, cookie, header string) bool {
	if cookie == "" || header == "" || subtle.ConstantTimeCompare([]byte(cookie), []byte(header)) != 1 {
		return false
	}
	digest, ok := secretDigest(header)
	return ok && subtle.ConstantTimeCompare(digest[:], session.csrfHash[:]) == 1
}

func (s *Service) Logout(ctx context.Context, session Session) error {
	now := s.now().UTC()
	return audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		tag, err := q.Exec(ctx, `UPDATE app.sessions SET revoked_at=$2 WHERE id=$1::uuid AND revoked_at IS NULL AND expires_at>$2`, session.ID, now)
		if err != nil {
			return audit.Event{}, err
		}
		if tag.RowsAffected() != 1 {
			return audit.Event{}, ErrUnauthorized
		}
		exists := false
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: session.User.ID}, Action: audit.Archived, ResourceKind: "session", ResourceID: session.ID, After: &audit.Snapshot{Exists: &exists}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
}
