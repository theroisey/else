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

func TestTaskMigrationRefusesTaskAndPermissionHistory(t *testing.T) {
	t.Run("task history", func(t *testing.T) {
		f := newTaskFixture(t)
		m := f.create(t, clientAID, tasks.CreateInput{Profile: taskProfile()})
		p := provider(t, f.base)
		if _, err := p.DownTo(f.base.ctx, 8); err != nil {
			t.Fatal("later-domain rollback failed", err)
		}
		if _, err := p.Down(f.base.ctx); err != nil {
			t.Fatal("empty planning rollback failed", err)
		}
		if _, err := p.Down(f.base.ctx); err == nil {
			t.Fatal("populated task rollback was allowed")
		}
		if _, err := f.tasks.Detail(f.base.ctx, f.actor, clientAID, m.ID); err != nil {
			t.Fatal("refused rollback lost task", err)
		}
	})
	t.Run("revoked permission history", func(t *testing.T) {
		f := newTaskFixture(t)
		ctx := correlation.New(f.base.ctx)
		role, err := f.accounts.CreateRole(ctx, f.actor, "Granular task role", []authorization.Permission{authorization.TasksCreate})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.accounts.ReplacePermissions(ctx, f.actor, role.ID, 1, []authorization.Permission{authorization.TasksView}); err != nil {
			t.Fatal(err)
		}
		p := provider(t, f.base)
		if _, err := p.DownTo(f.base.ctx, 8); err != nil {
			t.Fatal("later-domain rollback failed", err)
		}
		if _, err := p.Down(f.base.ctx); err != nil {
			t.Fatal("empty planning rollback failed", err)
		}
		if _, err := p.Down(f.base.ctx); err == nil {
			t.Fatal("revoked granular permission history was erased")
		}
	})
	t.Run("audit-only history", func(t *testing.T) {
		f := newTaskFixture(t)
		exists := true
		status := "done"
		err := audit.WithTransaction(correlation.New(f.base.ctx), f.runtime, func(_ctx context.Context, _q audit.Queries) (audit.Event, error) {
			return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: f.actor}, Action: audit.Completed, ResourceKind: "task", ResourceID: "99999999-9999-4999-8999-999999999999", ClientID: clientAID, After: &audit.Snapshot{Exists: &exists, TaskStatus: &status}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		p := provider(t, f.base)
		if _, err := p.DownTo(f.base.ctx, 8); err != nil {
			t.Fatal("later-domain rollback failed", err)
		}
		if _, err := p.Down(f.base.ctx); err != nil {
			t.Fatal("empty planning rollback failed", err)
		}
		if _, err := p.Down(f.base.ctx); err == nil {
			t.Fatal("task audit-only history was erased")
		}
	})
}

func TestTaskMigrationPreservesClientAndAuthorizationHistory(t *testing.T) {
	f := newClientFixture(t)
	ctx := correlation.New(f.base.ctx)
	m, err := f.records.Create(ctx, f.actor, profileFixture())
	if err != nil {
		t.Fatal(err)
	}
	p := provider(t, f.base)
	if _, err := p.DownTo(f.base.ctx, 8); err != nil {
		t.Fatal("later-domain rollback failed", err)
	}
	if _, err := p.Down(f.base.ctx); err != nil {
		t.Fatal("empty planning rollback failed", err)
	}
	if _, err := p.Down(f.base.ctx); err != nil {
		t.Fatal("unused task rollback failed", err)
	}
	var before, after int
	var keys int
	if err := f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app.audit_events").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Up(f.base.ctx); err != nil {
		t.Fatal("task upgrade failed", err)
	}
	if err := f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.audit_events),(SELECT count(*) FROM app.permissions)`).Scan(&after, &keys); err != nil || after != before || keys != 33 {
		t.Fatal("task migration changed existing history", err)
	}
	detail, err := f.records.Detail(ctx, f.actor, m.ID)
	if err != nil || detail.Revision != 1 || detail.Name != profileFixture().Name || len(detail.Contacts) != 1 || len(detail.Tags) != 2 {
		t.Fatal("task upgrade changed client profile", err)
	}
	grants, err := f.authorizer.Grants(ctx, f.actor)
	if err != nil || len(grants) != 33 {
		t.Fatal("task upgrade failed catalog compatibility", err)
	}
	if _, err := p.DownTo(f.base.ctx, 8); err != nil {
		t.Fatal("later-domain rollback failed", err)
	}
	if _, err := p.Down(f.base.ctx); err != nil {
		t.Fatal("empty planning rollback failed", err)
	}
	if _, err := p.Down(f.base.ctx); err != nil {
		t.Fatal("unused task rollback with existing client history failed", err)
	}
	if err := f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app.permissions").Scan(&keys); err != nil || keys != 19 {
		t.Fatal("task rollback changed old catalog", err)
	}
}

func TestTaskAuditDatabaseRejectsUnreviewedStatesAndKinds(t *testing.T) {
	f := newTaskFixture(t)
	ctx := correlation.New(f.base.ctx)
	for _, input := range []struct{ kind, action, payload string }{
		{"task", "completed", `{"task_status":"secret"}`}, {"task", "completed", `{"task_status":null}`}, {"task", "completed", `{"task_status":1}`},
		{"task", "completed", `{"task_status":"done","title":"Synthetic private text"}`}, {"client", "updated", `{"task_status":"done"}`},
		{"client", "completed", `null`}, {"user", "cancelled", `null`},
	} {
		_, err := f.runtime.Exec(ctx, `INSERT INTO app.audit_events `+auditColumns+` VALUES ('user',$1::uuid,$2,$3,$4::uuid,$5::uuid,$6,'null',$7::jsonb,'{"source":"http"}')`, f.actor, input.kind+"."+input.action, input.kind, fixtureID, clientAID, correlation.ID(ctx), input.payload)
		if err == nil {
			t.Fatal("database accepted unreviewed task audit")
		}
	}
}
