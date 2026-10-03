// Package vault persists integration envelopes without exposing credentials or
// claiming provider success. No HTTP/provider/startup adapter is supplied.
package vault

import (
	"context"
	"errors"
	"math"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/budget"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
)

var (
	ErrInvalid     = errors.New("invalid integration credential request")
	ErrMissing     = errors.New("integration credential unavailable for this client")
	ErrConflict    = errors.New("integration credential revision conflict")
	ErrExhausted   = errors.New("integration encryption budget exhausted")
	ErrUnavailable = errors.New("integration credential unavailable")
	uuid           = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type Service struct {
	pool       *pgxpool.Pool
	ring       *credentials.Keyring
	encryption *budget.Service
}

// Checkpoint is private backend context, never a public connection projection.
// CredentialRevision 0 means absent. Reconcile after an uncertain commit before
// deciding whether to retry; generation changes fence older provider work.
type Checkpoint struct {
	ConnectionRevision int64
	Generation         int64
	CredentialRevision int64
}

func NewService(pool *pgxpool.Pool, ring *credentials.Keyring) (*Service, error) {
	encryption, e := budget.NewService(pool, ring)
	if e != nil {
		return nil, ErrInvalid
	}
	return &Service{pool, ring, encryption}, nil
}
func validID(id string) bool {
	return uuid.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
}
func validRequest(ctx context.Context, actor, client, connection string) bool {
	return ctx != nil && correlation.ID(ctx) != "" && validID(actor) && validID(client) && validID(connection)
}
func (c Checkpoint) valid() bool {
	return c.ConnectionRevision > 0 && c.Generation > 0 && c.CredentialRevision >= 0
}
func (c Checkpoint) writable(rewrap bool) bool {
	return c.valid() && c.ConnectionRevision < math.MaxInt64 && c.CredentialRevision < math.MaxInt64 && (rewrap || c.Generation < math.MaxInt64)
}
func safeError(e error) error {
	switch {
	case errors.Is(e, ErrInvalid), errors.Is(e, budget.ErrInvalid):
		return ErrInvalid
	case errors.Is(e, ErrMissing), errors.Is(e, budget.ErrMissing), errors.Is(e, pgx.ErrNoRows):
		return ErrMissing
	case errors.Is(e, ErrConflict):
		return ErrConflict
	case errors.Is(e, ErrExhausted), errors.Is(e, budget.ErrExhausted):
		return ErrExhausted
	}
	var p *pgconn.PgError
	if errors.As(e, &p) {
		switch p.Code {
		case "P0002":
			return ErrMissing
		case "P0003":
			return ErrConflict
		case "22023":
			return ErrInvalid
		}
	}
	return ErrUnavailable
}

func (s *Service) read(ctx context.Context, actor, client, connection string) (Checkpoint, int64, credentials.Envelope, error) {
	tx, e := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if e != nil {
		return Checkpoint{}, 0, credentials.Envelope{}, ErrUnavailable
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	var current Checkpoint
	var generation int64
	var raw []byte
	e = tx.QueryRow(ctx, `SELECT connection_revision,connection_generation,credential_revision,credential_generation,envelope FROM app.integration_credential_read($1::uuid,$2::uuid,$3::uuid)`, actor, client, connection).Scan(&current.ConnectionRevision, &current.Generation, &current.CredentialRevision, &generation, &raw)
	defer clear(raw)
	if e != nil {
		return Checkpoint{}, 0, credentials.Envelope{}, safeError(e)
	}
	var envelope credentials.Envelope
	if !current.valid() {
		return Checkpoint{}, 0, envelope, ErrUnavailable
	}
	if current.CredentialRevision == 0 {
		if len(raw) != 0 || generation != 0 {
			return Checkpoint{}, 0, envelope, ErrUnavailable
		}
	} else {
		if generation < 1 {
			return Checkpoint{}, 0, envelope, ErrUnavailable
		}
		envelope, e = credentials.ParseEnvelope(raw)
		if e != nil {
			return Checkpoint{}, 0, credentials.Envelope{}, ErrUnavailable
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return Checkpoint{}, 0, credentials.Envelope{}, ErrUnavailable
	}
	return current, generation, envelope, nil
}

// Inspect returns a checkpoint under fresh exact-client management authority.
// It consumes no encryption budget, changes no state and writes no audit event.
func (s *Service) Inspect(ctx context.Context, actor, client, connection string) (Checkpoint, error) {
	if !validRequest(ctx, actor, client, connection) {
		return Checkpoint{}, ErrInvalid
	}
	c, _, _, e := s.read(ctx, actor, client, connection)
	return c, e
}

func (s *Service) persist(ctx context.Context, actor, client, connection string, expected Checkpoint, result budget.Result, rewrap bool) (Checkpoint, error) {
	if result.Revision != expected.ConnectionRevision || result.Generation != expected.Generation {
		return Checkpoint{}, ErrConflict
	}
	label, digest, e := s.ring.ActiveKeyIdentity()
	if e != nil {
		return Checkpoint{}, ErrUnavailable
	}
	raw := result.Envelope.Binary()
	defer clear(raw)
	var next Checkpoint
	e = audit.WithTransactionEvents(ctx, s.pool, func(ctx context.Context, q audit.Queries) ([]audit.Event, error) {
		if e := q.QueryRow(ctx, `SELECT connection_revision,connection_generation,credential_revision FROM app.integration_credential_write($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10)`, actor, client, connection, expected.ConnectionRevision, expected.Generation, expected.CredentialRevision, label, digest[:], raw, rewrap).Scan(&next.ConnectionRevision, &next.Generation, &next.CredentialRevision); e != nil {
			return nil, e
		}
		generation := expected.Generation
		if !rewrap {
			generation++
		}
		if next.ConnectionRevision != expected.ConnectionRevision+1 || next.Generation != generation || next.CredentialRevision != expected.CredentialRevision+1 {
			return nil, ErrUnavailable
		}
		exists, yes := expected.CredentialRevision != 0, true
		action := audit.Updated
		if !exists {
			action = audit.Created
		}
		base := audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, ResourceID: connection, ClientID: client, Metadata: audit.Metadata{Source: audit.CLI}}
		credential := base
		credential.ResourceKind = "integration_credential"
		credential.Action = action
		credential.Before = &audit.Snapshot{Exists: &exists}
		if exists {
			credential.Before.Revision = &expected.CredentialRevision
		}
		credential.After = &audit.Snapshot{Exists: &yes, Revision: &next.CredentialRevision}
		metadata := base
		metadata.ResourceKind = "integration_connection"
		metadata.Action = audit.Updated
		metadata.Before = &audit.Snapshot{Exists: &yes, Revision: &expected.ConnectionRevision}
		metadata.After = &audit.Snapshot{Exists: &yes, Revision: &next.ConnectionRevision}
		return []audit.Event{credential, metadata}, nil
	})
	if e != nil {
		return Checkpoint{}, safeError(e)
	}
	return next, nil
}

// Replace advances token generation but leaves provider state unchanged. The
// caller owns plaintext and must protect/clear it. No result on failed commit.
func (s *Service) Replace(ctx context.Context, actor, client, connection string, expected Checkpoint, plaintext []byte) (Checkpoint, error) {
	if !validRequest(ctx, actor, client, connection) || !expected.valid() || len(plaintext) == 0 || len(plaintext) > credentials.MaxPlaintextBytes {
		return Checkpoint{}, ErrInvalid
	}
	current, _, _, e := s.read(ctx, actor, client, connection)
	if e != nil {
		return Checkpoint{}, e
	}
	if current != expected || !expected.writable(false) {
		return Checkpoint{}, ErrConflict
	}
	result, e := s.encryption.Seal(ctx, actor, client, connection, plaintext)
	if e != nil {
		return Checkpoint{}, safeError(e)
	}
	return s.persist(ctx, actor, client, connection, expected, result, false)
}

// Rewrap processes exactly one stored row with retained-key authentication and
// active-key accounting. Generation is preserved; full revision CAS prevents a
// rotation from overwriting a newer token. Repeated calls require a fresh checkpoint.
func (s *Service) Rewrap(ctx context.Context, actor, client, connection string, expected Checkpoint) (Checkpoint, error) {
	if !validRequest(ctx, actor, client, connection) || !expected.valid() {
		return Checkpoint{}, ErrInvalid
	}
	current, generation, envelope, e := s.read(ctx, actor, client, connection)
	if e != nil {
		return Checkpoint{}, e
	}
	if current.CredentialRevision == 0 && current == expected {
		return Checkpoint{}, ErrMissing
	}
	if current != expected || !expected.writable(true) || generation != expected.Generation {
		return Checkpoint{}, ErrConflict
	}
	result, e := s.encryption.Rewrap(ctx, actor, client, connection, envelope)
	if e != nil {
		return Checkpoint{}, safeError(e)
	}
	return s.persist(ctx, actor, client, connection, expected, result, true)
}
