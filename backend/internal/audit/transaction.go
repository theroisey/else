package audit

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/correlation"
)

// Queries exposes business queries without transaction lifecycle methods.
// Callbacks contain trusted, reviewed SQL, never caller-provided SQL or explicit
// transaction-control commands. Do not retain this value beyond the callback.
type Queries interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type queries struct{ tx pgx.Tx }

func (q queries) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return q.tx.Exec(ctx, sql, args...)
}
func (q queries) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return q.tx.Query(ctx, sql, args...)
}
func (q queries) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return q.tx.QueryRow(ctx, sql, args...)
}

// Error keeps the original cause available to errors.Is/As, while its text is
// safe for ordinary logs. Never log its unwrapped database/callback error.
type Error struct {
	Operation string
	cause     error
}

func (e *Error) Error() string { return "audited transaction " + e.Operation + " failed" }
func (e *Error) Unwrap() error { return e.cause }

// WithTransaction runs a mutation and its mandatory event in one transaction.
// The callback returns the event after computing safe before/after markers.
// No event is written for reads or failed operations. Commit errors can have an
// unknown outcome: callers must reconcile, rather than blindly retry mutations.
func WithTransaction(ctx context.Context, pool *pgxpool.Pool, mutate func(context.Context, Queries) (Event, error)) error {
	if mutate == nil {
		return ErrInvalidEvent
	}
	return WithTransactionEvents(ctx, pool, func(ctx context.Context, q Queries) ([]Event, error) {
		event, err := mutate(ctx, q)
		return []Event{event}, err
	})
}

// WithTransactionEvents is the multi-event form used when one business
// operation necessarily changes more than one auditable resource.
func WithTransactionEvents(ctx context.Context, pool *pgxpool.Pool, mutate func(context.Context, Queries) ([]Event, error)) error {
	if correlation.ID(ctx) == "" {
		return ErrMissingCorrelation
	}
	if pool == nil || mutate == nil {
		return ErrInvalidEvent
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return &Error{Operation: "begin", cause: err}
	}
	defer func() {
		// Cancellation or panic must not leave a live transaction in the pool.
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup) // ErrTxClosed after commit; pgx discards on rollback failure.
	}()
	events, err := mutate(ctx, queries{tx: tx})
	if err != nil {
		return &Error{Operation: "mutation", cause: err}
	}
	if len(events) == 0 {
		return ErrInvalidEvent
	}
	for _, event := range events {
		before, after, metadata, err := event.encode()
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO app.audit_events
			(actor_kind, actor_user_id, event_name, resource_kind, resource_id, client_id,
			 request_id, before_state, after_state, metadata)
			VALUES ($1, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
			event.Actor.Kind, nullable(event.Actor.UserID), event.ResourceKind+"."+string(event.Action),
			event.ResourceKind, event.ResourceID, nullable(event.ClientID), correlation.ID(ctx), before, after, metadata)
		if err != nil {
			return &Error{Operation: "audit insert", cause: err}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return &Error{Operation: "commit", cause: err}
	}
	return nil
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
