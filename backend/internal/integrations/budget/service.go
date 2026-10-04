// Package budget enforces durable per-material accounting before integration
// credential encryption in the reviewed backend application path.
package budget

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/catalog"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
)

const MaxReservations int64 = 1 << 24

var (
	ErrInvalid     = errors.New("invalid integration encryption request")
	ErrMissing     = errors.New("integration encryption unavailable for this client")
	ErrExhausted   = errors.New("integration encryption budget exhausted")
	ErrUnavailable = errors.New("integration encryption unavailable")
	uuid           = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type Service struct {
	pool *pgxpool.Pool
	ring *credentials.Keyring
}

// Result is backend-only. Future storage must compare revision/generation under
// fresh authorization; ciphertext does not authorize a connection write.
type Result struct {
	Envelope   credentials.Envelope
	Revision   int64
	Generation int64
}

func NewService(pool *pgxpool.Pool, ring *credentials.Keyring) (*Service, error) {
	if pool == nil {
		return nil, ErrInvalid
	}
	if _, _, e := ring.ActiveKeyIdentity(); e != nil {
		return nil, ErrInvalid
	}
	return &Service{pool, ring}, nil
}
func validID(id string) bool {
	return uuid.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
}
func requestValid(ctx context.Context, actor, client, connection string) bool {
	return ctx != nil && correlation.ID(ctx) != "" && validID(actor) && validID(client) && validID(connection)
}
func safeError(e error) error {
	switch {
	case errors.Is(e, ErrInvalid):
		return ErrInvalid
	case errors.Is(e, ErrMissing), errors.Is(e, pgx.ErrNoRows):
		return ErrMissing
	case errors.Is(e, ErrExhausted):
		return ErrExhausted
	case errors.Is(e, credentials.ErrOpen):
		return credentials.ErrOpen
	}
	var p *pgconn.PgError
	if errors.As(e, &p) {
		switch p.Code {
		case "P0002":
			return ErrMissing
		case "P0001":
			return ErrExhausted
		case "22023", "23505":
			return ErrInvalid
		}
	}
	return ErrUnavailable
}

// reserve commits independently before encryption. Audit/commit failure must
// never lead to encryption; uncertain outcomes may consume capacity, never retry.
func (s *Service) reserve(ctx context.Context, actor, client, connection string) error {
	label, digest, e := s.ring.ActiveKeyIdentity()
	if e != nil {
		return ErrUnavailable
	}
	e = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var reservation string
		if e := q.QueryRow(ctx, `SELECT app.integration_encryption_reserve($1::uuid,$2::uuid,$3::uuid,$4,$5)::text`, actor, client, connection, label, digest[:]).Scan(&reservation); e != nil {
			return audit.Event{}, e
		}
		if !validID(reservation) {
			return audit.Event{}, ErrUnavailable
		}
		before, after := false, true
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, Action: audit.Created, ResourceKind: "integration_encryption", ResourceID: reservation, ClientID: client, Before: &audit.Snapshot{Exists: &before}, After: &audit.Snapshot{Exists: &after}, Metadata: audit.Metadata{Source: audit.CLI}}, nil
	})
	if e != nil {
		return safeError(e)
	}
	return nil
}

func (s *Service) encrypt(ctx context.Context, actor, client, connection string, operation func(credentials.Binding) (credentials.Envelope, error)) (Result, error) {
	if e := s.reserve(ctx, actor, client, connection); e != nil {
		return Result{}, e
	}
	tx, e := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if e != nil {
		return Result{}, ErrUnavailable
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	var binding credentials.Binding
	var revision, generation int64
	e = tx.QueryRow(ctx, `SELECT client_id::text,connection_id::text,provider,revision,generation FROM app.integration_encryption_binding($1::uuid,$2::uuid,$3::uuid)`, actor, client, connection).Scan(&binding.ClientID, &binding.ConnectionID, &binding.Provider, &revision, &generation)
	if e != nil {
		return Result{}, safeError(e)
	}
	purpose, supported := catalog.CredentialPurpose(binding.Provider)
	if binding.ClientID != client || binding.ConnectionID != connection || !supported || revision < 1 || generation < 1 {
		return Result{}, ErrUnavailable
	}
	binding.Purpose = purpose
	if ctx.Err() != nil {
		return Result{}, ErrUnavailable
	}
	envelope, e := operation(binding) // Shared lifecycle lock stays held through crypto.
	if e != nil {
		return Result{}, safeError(e)
	}
	if ctx.Err() != nil {
		return Result{}, ErrUnavailable
	}
	if e = tx.Commit(ctx); e != nil {
		return Result{}, ErrUnavailable
	}
	return Result{envelope, revision, generation}, nil
}

// Seal reserves one durable unit before encrypting under fresh exact-client
// grants. Committed reservations are never refunded, even if no result returns.
func (s *Service) Seal(ctx context.Context, actor, client, connection string, plaintext []byte) (Result, error) {
	if !requestValid(ctx, actor, client, connection) || len(plaintext) == 0 || len(plaintext) > credentials.MaxPlaintextBytes {
		return Result{}, ErrInvalid
	}
	return s.encrypt(ctx, actor, client, connection, func(b credentials.Binding) (credentials.Envelope, error) { return s.ring.Seal(b, plaintext) })
}

// Rewrap burns one unit of the active key before authenticating and sealing.
// Retained keys permit reads; malformed/wrong-binding envelopes return no data.
func (s *Service) Rewrap(ctx context.Context, actor, client, connection string, envelope credentials.Envelope) (Result, error) {
	if !requestValid(ctx, actor, client, connection) {
		return Result{}, ErrInvalid
	}
	raw := envelope.Binary()
	_, e := credentials.ParseEnvelope(raw)
	clear(raw)
	if e != nil {
		return Result{}, credentials.ErrOpen
	}
	return s.encrypt(ctx, actor, client, connection, func(b credentials.Binding) (credentials.Envelope, error) { return s.ring.Rewrap(b, envelope) })
}
