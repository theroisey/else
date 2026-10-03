// Package inventory observes live retained ciphertext counts for globally
// authorized trusted operators. It never establishes backup/key retirement.
package inventory

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
)

var (
	ErrInvalid     = errors.New("invalid integration inventory request")
	ErrMissing     = errors.New("integration inventory unavailable for this actor")
	ErrUnavailable = errors.New("integration inventory unavailable")
	uuid           = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type Service struct {
	pool *pgxpool.Pool
	ring *credentials.Keyring
}

// Count positions address lexicographically sorted labels in this exact source.
// No identity, capacity or key-retirement assertion is projected.
type Count struct {
	Position     int    `json:"position"`
	Active       bool   `json:"active"`
	StoredRows   string `json:"stored_rows"`
	EligibleRows string `json:"eligible_rows"`
	ExcludedRows string `json:"excluded_rows"`
}

func NewService(pool *pgxpool.Pool, ring *credentials.Keyring) (*Service, error) {
	if pool == nil {
		return nil, ErrInvalid
	}
	if _, _, err := ring.ActiveKeyIdentity(); err != nil {
		return nil, ErrInvalid
	}
	return &Service{pool, ring}, nil
}

func safeError(err error) error {
	var p *pgconn.PgError
	if errors.As(err, &p) {
		if p.Code == "P0002" {
			return ErrMissing
		}
		if p.Code == "22023" {
			return ErrInvalid
		}
	}
	return ErrUnavailable
}

// Observe performs one read-only live observation after fresh global grants and
// complete source matching. Normal mode permits exhausted active material;
// declared restored mode still requires its active identity to be unregistered.
func (s *Service) Observe(ctx context.Context, actor string, restored bool) ([]Count, error) {
	if s == nil || ctx == nil || correlation.ID(ctx) == "" || !uuid.MatchString(actor) || actor == "00000000-0000-0000-0000-000000000000" {
		return nil, ErrInvalid
	}
	active, _, err := s.ring.ActiveKeyIdentity()
	if err != nil {
		return nil, ErrUnavailable
	}
	labels, digests, err := s.ring.KeyIdentities()
	if err != nil {
		return nil, ErrUnavailable
	}
	defer func() {
		for _, d := range digests {
			clear(d)
		}
	}()
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(bounded, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, ErrUnavailable
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	rows, err := tx.Query(bounded, `SELECT key_position,is_active,stored_rows,eligible_rows,excluded_rows FROM app.integration_key_inventory($1::uuid,$2::text[],$3::bytea[],$4,$5)`, actor, labels, digests, active, restored)
	if err != nil {
		return nil, safeError(err)
	}
	defer rows.Close()
	counts := make([]Count, 0, len(labels))
	for rows.Next() {
		var item Count
		var total, eligible, excluded int64
		if rows.Scan(&item.Position, &item.Active, &total, &eligible, &excluded) != nil {
			return nil, ErrUnavailable
		}
		if len(counts) >= len(labels) || item.Position != len(counts)+1 || item.Active != (labels[len(counts)] == active) || total < 0 || eligible < 0 || eligible > total || excluded != total-eligible || (item.Active && eligible != 0) {
			return nil, ErrUnavailable
		}
		item.StoredRows, item.EligibleRows, item.ExcludedRows = strconv.FormatInt(total, 10), strconv.FormatInt(eligible, 10), strconv.FormatInt(excluded, 10)
		counts = append(counts, item)
	}
	if err := rows.Err(); err != nil {
		return nil, safeError(err)
	}
	rows.Close()
	if len(counts) != len(labels) || tx.Commit(bounded) != nil {
		return nil, ErrUnavailable
	}
	return counts, nil
}
