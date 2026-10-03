//go:build integration

package integration

import (
	"context"
	"testing"

	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/tasks"
)

func TestReminderMigrationPreservesPopulatedPlanningTasksAndOldAudit(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := correlation.New(f.base.ctx)
	plan := f.createPlan(t, "", planningProfile())
	child := f.createPlan(t, plan.ID, planningProfile())
	task, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, child.ID, 1, []string{task.ID}); err != nil {
		t.Fatal(err)
	}
	var before int
	if err := f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	p := provider(t, f.base)
	if _, err := p.DownTo(ctx, 9); err != nil {
		t.Fatal("unused activity rollback failed", err)
	}
	for _, direction := range []string{"down", "up"} {
		var err error
		if direction == "down" {
			_, err = p.Down(ctx)
		} else {
			_, err = p.Up(ctx)
		}
		if err != nil {
			t.Fatal("unused reminder migration failed", err)
		}
		keysWant := 34
		if direction == "down" {
			keysWant = 26
		}
		var keys, events int
		if err := f.admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM app.permissions),(SELECT count(*) FROM app.audit_events)`).Scan(&keys, &events); err != nil || keys != keysWant || events != before {
			t.Fatal("reminder migration changed existing permission/audit history", err)
		}
		r, err := f.plans.Detail(ctx, f.actor, clientAID, plan.ID, child.ID)
		if err != nil || r.Revision != 2 || r.TaskIDs == nil || len(*r.TaskIDs) != 1 || (*r.TaskIDs)[0] != task.ID {
			t.Fatal("reminder migration lost planning/link history", err)
		}
		taskRecord, err := f.tasks.Detail(ctx, f.actor, clientAID, task.ID)
		if err != nil || taskRecord.Revision != 1 || taskRecord.Title != taskProfile().Title {
			t.Fatal("reminder migration lost tasks", err)
		}
	}
}

func TestReminderMigrationRefusesTerminalRecordsAuditAndPermissionHistory(t *testing.T) {
	for _, scenario := range []string{"completed", "dismissed", "audit-only", "custom revoked permission", "revoked seed permission"} {
		t.Run(scenario, func(t *testing.T) {
			f := newReminderFixture(t)
			ctx := correlation.New(f.base.ctx)
			switch scenario {
			case "completed", "dismissed":
				m := f.createReminder(t, reminderProfile())
				var err error
				if scenario == "completed" {
					_, err = f.reminders.Complete(ctx, f.actor, clientAID, m.ID, 1)
				} else {
					_, err = f.reminders.Dismiss(ctx, f.actor, clientAID, m.ID, 1)
				}
				if err != nil {
					t.Fatal(err)
				}
			case "audit-only":
				state := "pending"
				err := audit.WithTransaction(ctx, f.runtime, func(context.Context, audit.Queries) (audit.Event, error) {
					return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: f.actor}, Action: audit.Created, ResourceKind: "reminder", ResourceID: fixtureID, ClientID: clientAID, After: &audit.Snapshot{ReminderStatus: &state}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
				})
				if err != nil {
					t.Fatal(err)
				}
			case "custom revoked permission":
				role, err := f.accounts.CreateRole(ctx, f.actor, "Reminder custom history", []authorization.Permission{authorization.RemindersCreate})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := f.accounts.ReplacePermissions(ctx, f.actor, role.ID, 1, []authorization.Permission{authorization.TasksView}); err != nil {
					t.Fatal(err)
				}
			case "revoked seed permission":
				if _, err := f.admin.Exec(ctx, `UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id=$1::uuid AND permission_key='reminders.create'`, authorization.InitialAdministratorRoleID); err != nil {
					t.Fatal(err)
				}
			}
			p := provider(t, f.base)
			if _, err := p.DownTo(ctx, 9); err != nil {
				t.Fatal("unused activity rollback failed", err)
			}
			var beforeEvents, beforeKeys, beforeRecords int
			if err := f.admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM app.audit_events),(SELECT count(*) FROM app.permissions),(SELECT count(*) FROM app.reminders)`).Scan(&beforeEvents, &beforeKeys, &beforeRecords); err != nil {
				t.Fatal(err)
			}
			if _, err := p.Down(ctx); err == nil {
				t.Fatal("reminder rollback erased history")
			}
			var afterEvents, afterKeys, afterRecords, version int
			if err := f.admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM app.audit_events),(SELECT count(*) FROM app.permissions),(SELECT count(*) FROM app.reminders),(SELECT max(version_id) FROM public.goose_db_version WHERE is_applied)`).Scan(&afterEvents, &afterKeys, &afterRecords, &version); err != nil || afterEvents != beforeEvents || afterKeys != beforeKeys || afterRecords != beforeRecords || version != 9 {
				t.Fatal("refused rollback was not atomic", err)
			}
		})
	}
}
