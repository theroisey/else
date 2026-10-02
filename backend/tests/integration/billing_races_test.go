//go:build integration

package integration

import (
	"errors"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/billing"
	"github.com/theroisey/else/backend/internal/correlation"
	"sync"
	"testing"
	"time"
)

func TestBillingConcurrentPaymentsAndCommandReplayCommitOnce(t *testing.T) {
	for _, same := range []bool{false, true} {
		t.Run(map[bool]string{false: "competing payments", true: "identical retry"}[same], func(t *testing.T) {
			f := newBillingFixture(t)
			ctx := correlation.New(f.base.ctx)
			m := f.createCollection(t, billingProfile())
			results := make(chan struct {
				m billing.Mutation
				e error
			}, 2)
			var wg sync.WaitGroup
			for i := 1; i <= 2; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					if same {
						i = 1
					}
					out, e := f.billing.RecordPayment(ctx, f.actor, clientAID, m.ID, m.Revision, billingPayment(i, "50"))
					results <- struct {
						m billing.Mutation
						e error
					}{out, e}
				}(i)
			}
			wg.Wait()
			close(results)
			success, conflict, replay := 0, 0, 0
			var id string
			for r := range results {
				if r.e == nil {
					success++
					if r.m.Replayed {
						replay++
					}
					if id != "" && r.m.PaymentID != nil && id != *r.m.PaymentID {
						t.Fatal("retry returned different payment")
					}
					if r.m.PaymentID != nil {
						id = *r.m.PaymentID
					}
				} else if errors.Is(r.e, billing.ErrConflict) {
					conflict++
				} else {
					t.Fatal(r.e)
				}
			}
			if same && (success != 2 || replay != 1) || !same && (success != 1 || conflict != 1) {
				t.Fatal(success, conflict, replay)
			}
			c := f.collection(t, m)
			if c.PaidMinor != "50" || c.Revision != "2" || f.events(t, m.ID) != 2 {
				t.Fatal("concurrent duplicate mutated balance", c)
			}
			m.Revision = c.Revision
			m = f.payment(t, m, billingPayment(3, "50"))
			if c := f.collection(t, m); c.Status != "paid" || c.PaidMinor != "100" {
				t.Fatal(c)
			}
			history, e := f.billing.Payments(ctx, f.actor, clientAID, m.ID, "", 25)
			if e != nil || len(history.Data) != 2 || f.events(t, m.ID) != 3 {
				t.Fatal("duplicate payment history", e)
			}
		})
	}
}

func TestBillingConcurrentMetadataCancellationAndPaymentUseOneRevision(t *testing.T) {
	for _, operation := range []string{"update", "cancel"} {
		t.Run(operation, func(t *testing.T) {
			f := newBillingFixture(t)
			ctx := correlation.New(f.base.ctx)
			m := f.createCollection(t, billingProfile())
			out := make(chan error, 2)
			go func() {
				_, e := f.billing.RecordPayment(ctx, f.actor, clientAID, m.ID, m.Revision, billingPayment(1, "40"))
				out <- e
			}()
			go func() {
				var e error
				if operation == "cancel" {
					_, e = f.billing.Cancel(ctx, f.actor, clientAID, m.ID, m.Revision)
				} else {
					p := billingProfile()
					p.AmountMinor = "101"
					_, e = f.billing.Update(ctx, f.actor, clientAID, m.ID, m.Revision, p)
				}
				out <- e
			}()
			success, conflicts := 0, 0
			for i := 0; i < 2; i++ {
				e := <-out
				if e == nil {
					success++
				} else if errors.Is(e, billing.ErrConflict) {
					conflicts++
				} else {
					t.Fatal(e)
				}
			}
			if success != 1 || conflicts != 1 {
				t.Fatal("lost revision", success, conflicts)
			}
			c := f.collection(t, m)
			if c.Revision != "2" || f.events(t, m.ID) != 2 {
				t.Fatal(c)
			}
			if c.PaidMinor == "40" && (c.AmountMinor != "100" || c.CancelledAt != nil) {
				t.Fatal("competing command changed paid obligation", c)
			}
		})
	}
}

func TestBillingQueuedPaymentRechecksActorAndClientAfterWriterLock(t *testing.T) {
	for _, scenario := range []string{"revoked", "disabled", "archived"} {
		t.Run(scenario, func(t *testing.T) {
			f := newBillingFixture(t)
			ctx := correlation.New(f.base.ctx)
			m := f.createCollection(t, billingProfile())
			writer, assignment := f.grantPlanning(t, []authorization.Permission{authorization.BillingView, authorization.BillingUpdate})
			tx, e := f.admin.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback(ctx)
			if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); e != nil {
				t.Fatal(e)
			}
			want := billing.ErrMissing
			switch scenario {
			case "revoked":
				_, e = tx.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, assignment)
			case "disabled":
				_, e = tx.Exec(ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, writer)
			case "archived":
				want = billing.ErrConflict
				_, e = tx.Exec(ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID)
			}
			if e != nil {
				t.Fatal(e)
			}
			result := make(chan error, 1)
			go func() {
				_, e := f.billing.RecordPayment(ctx, writer, clientAID, m.ID, m.Revision, billingPayment(1, "1"))
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
					t.Fatal("financial writer skipped serialization lock")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if e = tx.Commit(ctx); e != nil {
				t.Fatal(e)
			}
			if e = <-result; !errors.Is(e, want) {
				t.Fatal("queued payment used stale authorization", scenario, e)
			}
			if c := f.collection(t, m); c.Revision != "1" || c.PaidMinor != "0" || f.events(t, m.ID) != 1 {
				t.Fatal("rejected queued payment retained changes", c)
			}
		})
	}
}

func TestBillingReplayStillRequiresOriginalActorAndCurrentPermissions(t *testing.T) {
	f := newBillingFixture(t)
	ctx := correlation.New(f.base.ctx)
	writer, assignment := f.grantPlanning(t, []authorization.Permission{authorization.BillingView, authorization.BillingUpdate})
	m := f.createCollection(t, billingProfile())
	p := billingPayment(1, "1")
	first, e := f.billing.RecordPayment(ctx, writer, clientAID, m.ID, m.Revision, p)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.billing.RecordPayment(ctx, f.actor, clientAID, m.ID, m.Revision, p); !errors.Is(e, billing.ErrConflict) {
		t.Fatal("another actor claimed committed command", e)
	}
	if e = f.authorizer.RevokeRole(ctx, f.actor, assignment); e != nil {
		t.Fatal(e)
	}
	if _, e = f.billing.RecordPayment(ctx, writer, clientAID, m.ID, m.Revision, p); !errors.Is(e, billing.ErrMissing) {
		t.Fatal("revoked actor reconciled private payment", e)
	}
	replay, e := f.billing.RecordPayment(ctx, f.actor, clientAID, m.ID, first.Revision, billingPayment(2, "1"))
	if e != nil || replay.Replayed {
		t.Fatal(e)
	}
}
