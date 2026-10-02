//go:build integration

package integration

import (
	"errors"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/pricing"
)

func TestPricingConcurrentAppendsAndIdenticalCopiesSerialize(t *testing.T) {
	f := newPricingFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.createPricing(t, pricingProfile())
	p := pricingProfile()
	p.EffectiveFrom = today()
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { _, e := f.pricing.Append(ctx, f.actor, clientAID, m.ID, m.Revision, p); results <- e }()
	}
	success, conflict := 0, 0
	for i := 0; i < 2; i++ {
		e := <-results
		if e == nil {
			success++
		} else if errors.Is(e, pricing.ErrConflict) {
			conflict++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || conflict != 1 || f.events(t, m.ID) != 2 {
		t.Fatal("concurrent append lost revision")
	}
	sheet, e := f.pricing.Detail(ctx, f.actor, clientAID, m.ID)
	if e != nil {
		t.Fatal(e)
	}
	copies := make(chan struct {
		m pricing.CollectionMutation
		e error
	}, 2)
	for i := 0; i < 2; i++ {
		go func() {
			c, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, sheet.LatestVersion.ID, sheet.Revision, pricingCopy(1))
			copies <- struct {
				m pricing.CollectionMutation
				e error
			}{c, e}
		}()
	}
	a, b := <-copies, <-copies
	if a.e != nil || b.e != nil || a.m.ID != b.m.ID || a.m.Replayed == b.m.Replayed || f.events(t, a.m.ID) != 1 {
		t.Fatal("duplicate collection committed", a.e, b.e)
	}
}

func TestPricingQueuedWritesRecheckRevocationDisableAndArchive(t *testing.T) {
	for _, operation := range []string{"append", "copy"} {
		for _, scenario := range []string{"revoked", "disabled", "archived"} {
			t.Run(operation+"/"+scenario, func(t *testing.T) {
				f := newPricingFixture(t)
				ctx := correlation.New(f.base.ctx)
				m := f.createPricing(t, pricingProfile())
				writer, assignment := f.grantPlanning(t, []authorization.Permission{authorization.PricingView, authorization.PricingManage, authorization.BillingView, authorization.BillingCreate})
				tx, e := f.admin.Begin(ctx)
				if e != nil {
					t.Fatal(e)
				}
				defer tx.Rollback(ctx)
				if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); e != nil {
					t.Fatal(e)
				}
				want := pricing.ErrMissing
				switch scenario {
				case "revoked":
					_, e = tx.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, assignment)
				case "disabled":
					_, e = tx.Exec(ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, writer)
				case "archived":
					want = pricing.ErrConflict
					_, e = tx.Exec(ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID)
				}
				if e != nil {
					t.Fatal(e)
				}
				result := make(chan error, 1)
				go func() {
					var e error
					if operation == "append" {
						p := pricingProfile()
						p.EffectiveFrom = today()
						_, e = f.pricing.Append(ctx, writer, clientAID, m.ID, m.Revision, p)
					} else {
						_, e = f.pricing.Copy(ctx, writer, clientAID, m.ID, m.VersionID, m.Revision, pricingCopy(1))
					}
					result <- e
				}()
				deadline := time.Now().Add(3 * time.Second)
				for {
					var waiting bool
					if e = f.adminPool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory')`).Scan(&waiting); e != nil {
						t.Fatal(e)
					}
					if waiting {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("pricing writer skipped lifecycle lock")
					}
					time.Sleep(10 * time.Millisecond)
				}
				if e = tx.Commit(ctx); e != nil {
					t.Fatal(e)
				}
				if e = <-result; !errors.Is(e, want) {
					t.Fatal("queued write used stale grants/lifecycle", e)
				}
				var collections int
				if e = f.admin.QueryRow(ctx, `SELECT count(*) FROM app.collections`).Scan(&collections); e != nil || collections != 0 || f.events(t, m.ID) != 1 {
					t.Fatal("rejected queued writer retained changes", e)
				}
			})
		}
	}
}
