package keysource

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
)

// Preflight is a read-only startup check, not a reservation or authorization for
// future credential writes. Undeclared snapshot rewinds cannot be detected.
func Preflight(ctx context.Context, pool *pgxpool.Pool, ring *credentials.Keyring, restored bool) error {
	if ctx == nil || ctx.Err() != nil || pool == nil {
		return ErrUnavailable
	}
	active, _, err := ring.ActiveKeyIdentity()
	if err != nil {
		return ErrUnavailable
	}
	labels, digests, err := ring.KeyIdentities()
	if err != nil {
		return ErrUnavailable
	}
	defer func() {
		for _, digest := range digests {
			clear(digest)
		}
	}()
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := pool.BeginTx(bounded, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return ErrUnavailable
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	var valid bool
	err = tx.QueryRow(bounded, `SELECT app.integration_key_preflight($1::text[],$2::bytea[],$3,$4)`, labels, digests, active, restored).Scan(&valid)
	if err != nil || !valid || bounded.Err() != nil {
		return ErrUnavailable
	}
	if tx.Commit(bounded) != nil {
		return ErrUnavailable
	}
	return nil
}
