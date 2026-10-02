//go:build integration

package integration

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/reminders"
	"github.com/theroisey/else/backend/internal/tasks"
)

func TestReminderConcurrentEditsAndTerminalCommandsCommitOneRevision(t *testing.T) {
	f := newReminderFixture(t)
	ctx := correlation.New(f.base.ctx)
	for _, pair := range [][2]string{{"update", "update"}, {"complete", "dismiss"}, {"update", "complete"}} {
		m := f.createReminder(t, reminderProfile())
		results := make(chan error, 2)
		var wg sync.WaitGroup
		for _, action := range pair {
			wg.Add(1)
			go func(action string) {
				defer wg.Done()
				var err error
				if action == "update" {
					p := reminderProfile()
					p.OwnerID = f.actor
					p.Title = "Concurrent metadata"
					_, err = f.reminders.Update(ctx, f.actor, clientAID, m.ID, 1, p)
				} else if action == "complete" {
					_, err = f.reminders.Complete(ctx, f.actor, clientAID, m.ID, 1)
				} else {
					_, err = f.reminders.Dismiss(ctx, f.actor, clientAID, m.ID, 1)
				}
				results <- err
			}(action)
		}
		wg.Wait()
		close(results)
		success, conflicts := 0, 0
		for err := range results {
			if err == nil {
				success++
			} else if errors.Is(err, reminders.ErrConflict) {
				conflicts++
			} else {
				t.Fatal(err)
			}
		}
		if success != 1 || conflicts != 1 {
			t.Fatal("concurrent reminder writes lost revision protection")
		}
		r, err := f.reminders.Detail(ctx, f.actor, clientAID, m.ID)
		if err != nil || r.Revision != 2 {
			t.Fatal("concurrent revision mismatch", err)
		}
		var events int
		if err := f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid`, m.ID).Scan(&events); err != nil || events != 2 {
			t.Fatal("rejected concurrent write emitted audit", err)
		}
	}
}

func TestReminderWaitsForFreshActorOwnerClientAndResourceChecks(t *testing.T) {
	for _, scenario := range []string{"actor revoked", "actor disabled", "client archived", "owner revoked", "owner disabled", "task archived", "task access revoked", "plan archived", "planning access revoked", "milestone parent archived", "task completed", "plan completed"} {
		t.Run(scenario, func(t *testing.T) {
			f := newReminderFixture(t)
			ctx := correlation.New(f.base.ctx)
			m := f.createReminder(t, reminderProfile())
			writer, writerAssignment := f.grantPlanning(t, []authorization.Permission{authorization.RemindersView, authorization.RemindersCreate, authorization.RemindersUpdate})
			owner, ownerAssignment := f.grantPlanning(t, []authorization.Permission{authorization.RemindersView})
			task, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
			if err != nil {
				t.Fatal(err)
			}
			plan := f.createPlan(t, "", planningProfile())
			child := f.createPlan(t, plan.ID, planningProfile())
			reader, err := f.accounts.CreateRole(ctx, f.actor, "Reminder race resource reader", []authorization.Permission{authorization.TasksView, authorization.PlanningView})
			if err != nil {
				t.Fatal(err)
			}
			resourceAssignment, err := f.authorizer.AssignRole(ctx, f.actor, writer, reader.ID, authorization.Client, clientAID)
			if err != nil {
				t.Fatal(err)
			}
			p := reminderProfile()
			p.OwnerID = f.actor
			p.Title = "Raced reminder update"
			p.Resource = &reminders.Resource{Kind: "task", ID: task.ID}
			want := reminders.ErrResource
			tx, err := f.admin.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "actor revoked":
				want = reminders.ErrMissing
				_, err = tx.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, writerAssignment)
			case "actor disabled":
				want = reminders.ErrMissing
				_, err = tx.Exec(ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, writer)
			case "client archived":
				want = reminders.ErrConflict
				_, err = tx.Exec(ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID)
			case "owner revoked":
				want = reminders.ErrOwner
				p.OwnerID = owner
				_, err = tx.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, ownerAssignment)
			case "owner disabled":
				want = reminders.ErrOwner
				p.OwnerID = owner
				_, err = tx.Exec(ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, owner)
			case "task archived":
				_, err = tx.Exec(ctx, `UPDATE app.tasks SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, task.ID)
			case "task access revoked", "planning access revoked":
				_, err = tx.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, resourceAssignment)
				if scenario == "planning access revoked" {
					p.Resource = &reminders.Resource{Kind: "plan", ID: plan.ID}
				}
			case "plan archived":
				p.Resource = &reminders.Resource{Kind: "plan", ID: plan.ID}
				_, err = tx.Exec(ctx, `UPDATE app.plans SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, plan.ID)
			case "milestone parent archived":
				p.Resource = &reminders.Resource{Kind: "milestone", ID: child.ID}
				_, err = tx.Exec(ctx, `UPDATE app.plans SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, plan.ID)
			case "task completed":
				want = nil
				_, err = tx.Exec(ctx, `UPDATE app.tasks SET status='done',completed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, task.ID)
			case "plan completed":
				want = nil
				p.Resource = &reminders.Resource{Kind: "milestone", ID: child.ID}
				_, err = tx.Exec(ctx, `UPDATE app.plans SET status='completed',completed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, plan.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() { _, err := f.reminders.Update(ctx, writer, clientAID, m.ID, 1, p); result <- err }()
			deadline := time.Now().Add(3 * time.Second)
			for {
				var waiting bool
				if err := f.adminPool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory')`).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("reminder skipped shared writer lock")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = <-result
			if (want == nil && err != nil) || (want != nil && !errors.Is(err, want)) {
				t.Fatal("raced write used stale checks", scenario, err)
			}
			r, err := f.reminders.Detail(ctx, f.actor, clientAID, m.ID)
			revision := int64(1)
			events := 1
			if want == nil {
				revision = 2
				events = 2
			}
			if err != nil || r.Revision != revision || (want != nil && r.Resource != nil) {
				t.Fatal("raced rejection retained changes", err)
			}
			var count int
			if err := f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid`, m.ID).Scan(&count); err != nil || count != events {
				t.Fatal("raced audit count", err)
			}
		})
	}
}
