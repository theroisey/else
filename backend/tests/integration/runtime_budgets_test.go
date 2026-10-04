//go:build integration

package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/theroisey/else/backend/internal/database"
)

func TestRuntimePostgresCancellationBudgetsAndRecovery(t *testing.T) {
	f := newFixture(t)
	owner := connection(t, f)
	c := settings(t, f.URL)
	c.MaxConnections = 1 // One slot makes leaks/recovery observable; API stays ten.
	pool, err := database.Open(f.ctx, c)
	if err != nil {
		t.Fatal("private runtime pool unavailable")
	}
	defer pool.Close()
	if _, err := owner.Exec(f.ctx, `CREATE TABLE public.runtime_budget_probe(id integer PRIMARY KEY,value text NOT NULL); INSERT INTO public.runtime_budget_probe VALUES (1,'initial')`); err != nil {
		t.Fatal("private budget probe unavailable")
	}
	for setting, want := range map[string]string{"statement_timeout": "5s", "lock_timeout": "2s", "idle_in_transaction_session_timeout": "10s"} {
		var got string
		if pool.QueryRow(f.ctx, "SHOW "+setting).Scan(&got) != nil || got != want {
			t.Fatal("actual runtime SQL budget differs")
		}
	}
	checkRecovery := func() {
		t.Helper()
		var value string
		if pool.QueryRow(f.ctx, "SELECT value FROM public.runtime_budget_probe WHERE id=1").Scan(&value) != nil || value != "initial" || pool.Stat().AcquiredConns() != 0 {
			t.Fatal("runtime pool/transaction recovery failed")
		}
	}
	assertCode := func(err error, code string) {
		t.Helper()
		var pg *pgconn.PgError
		if !errors.As(err, &pg) || pg.Code != code {
			t.Fatal("expected server-side SQL timeout classification missing")
		}
	}
	_, err = pool.Exec(f.ctx, "SELECT pg_sleep(10)")
	assertCode(err, "57014")
	checkRecovery()
	lock, err := owner.Begin(f.ctx)
	if err != nil {
		t.Fatal("private lock transaction unavailable")
	}
	defer lock.Rollback(f.ctx)
	if _, err := lock.Exec(f.ctx, "SELECT id FROM public.runtime_budget_probe WHERE id=1 FOR UPDATE"); err != nil {
		t.Fatal("private row lock unavailable")
	}
	_, err = pool.Exec(f.ctx, "UPDATE public.runtime_budget_probe SET value='uncommitted private marker' WHERE id=1")
	assertCode(err, "55P03")
	// Context cancellation is earlier than the independent server lock budget.
	// Match audited business writes: an explicit transaction cannot commit after
	// caller cancellation. An implicit autocommit's network outcome is uncertain.
	blocked, err := pool.Begin(f.ctx)
	if err != nil {
		t.Fatal("private canceled transaction unavailable")
	}
	ctx, cancel := context.WithTimeout(f.ctx, 100*time.Millisecond)
	_, err = blocked.Exec(ctx, "UPDATE public.runtime_budget_probe SET value='uncommitted private marker' WHERE id=1")
	cancel()
	_ = blocked.Rollback(f.ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("query did not honor earlier caller deadline")
	}
	if lock.Rollback(f.ctx) != nil {
		t.Fatal("private lock release failed")
	}
	checkRecovery()
	// A server-terminated idle transaction must roll back its earlier write.
	tx, err := pool.Begin(f.ctx)
	if err != nil {
		t.Fatal("private idle transaction unavailable")
	}
	defer tx.Rollback(f.ctx)
	if _, err := tx.Exec(f.ctx, "UPDATE public.runtime_budget_probe SET value='uncommitted private marker' WHERE id=1"); err != nil {
		t.Fatal("private idle transaction write failed")
	}
	if _, err := owner.Exec(f.ctx, "SELECT pg_sleep(11)"); err != nil {
		t.Fatal("bounded idle timeout observation failed")
	}
	_, err = tx.Exec(f.ctx, "SELECT 1")
	assertCode(err, "25P03")
	_ = tx.Rollback(f.ctx)
	checkRecovery()
	migration, err := database.OpenMigration(f.ctx, c)
	if err != nil {
		t.Fatal("private migration connection unavailable")
	}
	defer migration.Close()
	for setting, want := range map[string]string{"statement_timeout": "30s", "lock_timeout": "5s", "idle_in_transaction_session_timeout": "0"} {
		var got string
		if migration.QueryRowContext(f.ctx, "SHOW "+setting).Scan(&got) != nil || got != want {
			t.Fatal("separate actual migration budget changed")
		}
	}
}
