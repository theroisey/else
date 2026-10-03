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

func TestPlanningMigrationPreservesExistingTasksClientsAndAuthorization(t *testing.T) {
	f := newTaskFixture(t)
	m := f.create(t, clientAID, tasks.CreateInput{Profile: taskProfile()})
	ctx := correlation.New(f.base.ctx)
	p := provider(t, f.base)
	if _, err := p.DownTo(ctx, 8); err != nil {
		t.Fatal("later-domain rollback failed", err)
	}
	var before int
	if err := f.admin.QueryRow(ctx, "SELECT count(*) FROM app.audit_events").Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, direction := range []string{"down", "up"} {
		var err error
		if direction == "down" {
			_, err = p.Down(ctx)
		} else {
			_, err = p.Up(ctx)
		}
		if err != nil {
			t.Fatal("unused planning migration failed", err)
		}
		var events, keys int
		if err = f.admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM app.audit_events),(SELECT count(*) FROM app.permissions)`).Scan(&events, &keys); err != nil || events != before || (direction == "down" && keys != 22) || (direction == "up" && keys != 34) {
			t.Fatal("planning migration changed old history", err)
		}
		r, err := f.tasks.Detail(ctx, f.actor, clientAID, m.ID)
		if err != nil || r.Revision != 1 || r.Title != taskProfile().Title || len(r.Tags) != 2 {
			t.Fatal("planning migration lost task history", err)
		}
	}
}

func TestPlanningMigrationRefusesRecordsAuditAndPermissionHistory(t *testing.T) {
	for _, scenario := range []string{"archived records and links", "audit-only history", "custom permission", "revoked seed permission"} {
		t.Run(scenario, func(t *testing.T) {
			f := newPlanningFixture(t)
			ctx := correlation.New(f.base.ctx)
			switch scenario {
			case "archived records and links":
				p := f.createPlan(t, "", planningProfile())
				m := f.createPlan(t, p.ID, planningProfile())
				task, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
				if err != nil {
					t.Fatal(err)
				}
				m, err = f.plans.ReplaceLinks(ctx, f.actor, clientAID, p.ID, m.ID, 1, []string{task.ID})
				if err != nil {
					t.Fatal(err)
				}
				if _, err = f.plans.Archive(ctx, f.actor, clientAID, p.ID, m.ID, m.Revision); err != nil {
					t.Fatal(err)
				}
				if _, err = f.plans.Archive(ctx, f.actor, clientAID, "", p.ID, 1); err != nil {
					t.Fatal(err)
				}
			case "audit-only history":
				state := "planned"
				if err := audit.WithTransaction(ctx, f.runtime, func(context.Context, audit.Queries) (audit.Event, error) {
					return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: f.actor}, Action: audit.Created, ResourceKind: "milestone", ResourceID: fixtureID, ClientID: clientAID, After: &audit.Snapshot{PlanningStatus: &state}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
				}); err != nil {
					t.Fatal(err)
				}
			case "custom permission":
				role, err := f.accounts.CreateRole(ctx, f.actor, "Planning history", []authorization.Permission{authorization.PlanningCreate})
				if err != nil {
					t.Fatal(err)
				}
				if _, err = f.accounts.ReplacePermissions(ctx, f.actor, role.ID, 1, []authorization.Permission{authorization.TasksView}); err != nil {
					t.Fatal(err)
				}
			case "revoked seed permission":
				if _, err := f.admin.Exec(ctx, `UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id=$1::uuid AND permission_key='planning.create'`, authorization.InitialAdministratorRoleID); err != nil {
					t.Fatal(err)
				}
			}
			p := provider(t, f.base)
			if _, err := p.DownTo(ctx, 8); err != nil {
				t.Fatal("later-domain rollback failed", err)
			}
			var beforeEvents, beforeKeys int
			if err := f.admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM app.audit_events),(SELECT count(*) FROM app.permissions)`).Scan(&beforeEvents, &beforeKeys); err != nil {
				t.Fatal(err)
			}
			if _, err := p.Down(ctx); err == nil {
				t.Fatal("planning rollback erased history")
			}
			var afterEvents, afterKeys int
			var tables bool
			if err := f.admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM app.audit_events),(SELECT count(*) FROM app.permissions),to_regclass('app.plans') IS NOT NULL AND to_regclass('app.milestone_task_links') IS NOT NULL`).Scan(&afterEvents, &afterKeys, &tables); err != nil || beforeEvents != afterEvents || beforeKeys != afterKeys || !tables {
				t.Fatal("refused rollback was not atomic", err)
			}
		})
	}
}
