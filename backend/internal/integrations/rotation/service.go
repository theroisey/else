// Package rotation rewraps bounded exact-client pages through the audited vault.
// Eligible-page completion never proves global rotation or safe key retirement.
package rotation

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
	"github.com/theroisey/else/backend/internal/integrations/keysource"
	"github.com/theroisey/else/backend/internal/integrations/vault"
)

const MaxPageSize = 100

var (
	ErrInvalid     = errors.New("invalid integration rotation request")
	ErrMissing     = errors.New("integration rotation unavailable for this client")
	ErrConflict    = errors.New("integration rotation revision conflict")
	ErrExhausted   = errors.New("integration rotation encryption budget exhausted")
	ErrUnavailable = errors.New("integration rotation unavailable")
	uuid           = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type Service struct {
	pool   *pgxpool.Pool
	ring   *credentials.Keyring
	rewrap func(context.Context, string, string, string, vault.Checkpoint) (vault.Checkpoint, error)
}

// Result contains only known committed progress. Pending requires explicit
// reconciliation before another request; no retry or cursor advance is implied.
// Only PageComplete && !More means this eligible scan reached its observed end.
// Reset ResumeAfter for a new client/key or changes behind the cursor.
type Result struct {
	Rewrapped    int
	ResumeAfter  string
	Pending      string
	PageComplete bool
	More         bool
}

type candidate struct {
	connection string
	checkpoint vault.Checkpoint
}

// NewService accepts a trusted immutable ring. The source owner must enforce
// protected loading/declared-restore startup and exclude stale old-key writers.
func NewService(pool *pgxpool.Pool, ring *credentials.Keyring) (*Service, error) {
	v, e := vault.NewService(pool, ring)
	if e != nil {
		return nil, ErrInvalid
	}
	return &Service{pool: pool, ring: ring, rewrap: v.Rewrap}, nil
}

func validID(id string) bool {
	return uuid.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
}
func safeError(e error) error {
	switch {
	case errors.Is(e, vault.ErrInvalid):
		return ErrInvalid
	case errors.Is(e, vault.ErrMissing), errors.Is(e, pgx.ErrNoRows):
		return ErrMissing
	case errors.Is(e, vault.ErrConflict):
		return ErrConflict
	case errors.Is(e, vault.ErrExhausted):
		return ErrExhausted
	}
	var p *pgconn.PgError
	if errors.As(e, &p) {
		switch p.Code {
		case "P0002":
			return ErrMissing
		case "22023":
			return ErrInvalid
		}
	}
	return ErrUnavailable
}

func (s *Service) candidates(ctx context.Context, actor, client, after string, limit int) ([]candidate, error) {
	label, digest, e := s.ring.ActiveKeyIdentity()
	if e != nil {
		return nil, ErrUnavailable
	}
	var cursor any
	if after != "" {
		cursor = after
	}
	tx, e := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, ErrUnavailable
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	rows, e := tx.Query(ctx, `SELECT connection_id::text,connection_revision,connection_generation,credential_revision FROM app.integration_rotation_candidates($1::uuid,$2::uuid,$3,$4,$5::uuid,$6)`, actor, client, label, digest[:], cursor, limit)
	if e != nil {
		return nil, safeError(e)
	}
	defer rows.Close()
	items := make([]candidate, 0, limit+1)
	previous := after
	for rows.Next() {
		var item candidate
		if e = rows.Scan(&item.connection, &item.checkpoint.ConnectionRevision, &item.checkpoint.Generation, &item.checkpoint.CredentialRevision); e != nil {
			return nil, ErrUnavailable
		}
		if !validID(item.connection) || item.connection <= previous || item.checkpoint.ConnectionRevision < 1 || item.checkpoint.Generation < 1 || item.checkpoint.CredentialRevision < 1 || len(items) >= limit+1 {
			return nil, ErrUnavailable
		}
		items = append(items, item)
		previous = item.connection
	}
	if e := rows.Err(); e != nil {
		return nil, safeError(e)
	}
	rows.Close() // Release the planning connection before any per-row vault work.
	if tx.Commit(ctx) != nil {
		return nil, ErrUnavailable
	}
	return items, nil
}

func (s *Service) apply(ctx context.Context, actor, client, after string, limit int, items []candidate) (Result, error) {
	r := Result{ResumeAfter: after, More: len(items) > limit}
	if r.More {
		items = items[:limit]
	}
	for _, item := range items {
		if ctx.Err() != nil {
			r.Pending = item.connection
			return r, ErrUnavailable
		}
		if _, e := s.rewrap(ctx, actor, client, item.connection, item.checkpoint); e != nil {
			r.Pending = item.connection
			return r, safeError(e)
		}
		r.Rewrapped++
		r.ResumeAfter = item.connection
	}
	if ctx.Err() != nil {
		return r, ErrUnavailable
	}
	r.PageComplete = true
	return r, nil
}

// Run processes at most limit rows in ascending UUID order. Earlier committed
// rows survive later failures. Selection is read-only; each row uses fresh vault
// authorization/CAS, audited irreversible accounting and retained-key crypto.
// No caller should infer retirement or provider health from this result.
func (s *Service) Run(ctx context.Context, actor, client, after string, limit int) (Result, error) {
	if ctx == nil || correlation.ID(ctx) == "" || !validID(actor) || !validID(client) || (after != "" && !validID(after)) || limit < 1 || limit > MaxPageSize {
		return Result{}, ErrInvalid
	}
	r := Result{ResumeAfter: after}
	bounded, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if keysource.Preflight(bounded, s.pool, s.ring, false) != nil {
		return r, ErrUnavailable
	}
	items, e := s.candidates(bounded, actor, client, after, limit)
	if e != nil {
		return r, e
	}
	return s.apply(bounded, actor, client, after, limit, items)
}
