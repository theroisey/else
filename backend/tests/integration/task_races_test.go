//go:build integration

package integration

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/tasks"
)

func TestTaskConcurrentEditsCommitOneRevisionAndEvent(t *testing.T) {
	f := newTaskFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.create(t, clientAID, tasks.CreateInput{Profile: taskProfile()})
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, title := range []string{"Concurrent task A", "Concurrent task B"} {
		wg.Add(1)
		go func(title string) {
			defer wg.Done()
			p := taskProfile()
			p.Title = title
			_, err := f.tasks.Update(ctx, f.actor, clientAID, m.ID, 1, p)
			results <- err
		}(title)
	}
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, tasks.ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatal("concurrent writes lost revision protection")
	}
	detail, err := f.tasks.Detail(ctx, f.actor, clientAID, m.ID)
	if err != nil || detail.Revision != 2 {
		t.Fatal("concurrent revision mismatch", err)
	}
	var events int
	if err := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid AND event_name='task.updated'`, m.ID).Scan(&events); err != nil || events != 1 {
		t.Fatal("failed concurrent write emitted an event", err)
	}
}
func TestTaskWaitsForFreshAuthorizationAndParentState(t *testing.T) {
	for _, scenario := range []string{"actor revoked", "assignee revoked", "assignee disabled", "parent archived"} {
		t.Run(scenario, func(t *testing.T) {
			f := newTaskFixture(t)
			ctx := correlation.New(f.base.ctx)
			actor := f.actor
			p := taskProfile()
			want := tasks.ErrAssignee
			user := f.user(t, "race.task@example.com")
			permissions := []authorization.Permission{authorization.TasksView}
			if scenario == "actor revoked" {
				permissions = []authorization.Permission{authorization.TasksCreate}
				actor = user.ID
				want = tasks.ErrMissing
			}
			role, err := f.accounts.CreateRole(ctx, f.actor, "Task race role", permissions)
			if err != nil {
				t.Fatal(err)
			}
			assignment, err := f.authorizer.AssignRole(ctx, f.actor, user.ID, role.ID, authorization.Client, clientAID)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "assignee revoked" || scenario == "assignee disabled" {
				p.AssigneeID = &user.ID
			}
			tx, err := f.admin.Begin(f.base.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(f.base.ctx)
			if _, err := tx.Exec(f.base.ctx, "SELECT pg_advisory_xact_lock(871092650209)"); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "actor revoked", "assignee revoked":
				_, err = tx.Exec(f.base.ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, assignment)
			case "assignee disabled":
				_, err = tx.Exec(f.base.ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, user.ID)
			case "parent archived":
				want = tasks.ErrConflict
				_, err = tx.Exec(f.base.ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID)
			}
			if err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() { _, err := f.tasks.Create(ctx, actor, clientAID, tasks.CreateInput{Profile: p}); result <- err }()
			deadline := time.Now().Add(3 * time.Second)
			for {
				var waiting bool
				if err := f.adminPool.QueryRow(f.base.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory')`).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("task write did not wait for boundary lock")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err := tx.Commit(f.base.ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-result; !errors.Is(err, want) {
				t.Fatal("task write used a stale authorization snapshot", err)
			}
			var records, events int
			if err := f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.tasks),(SELECT count(*) FROM app.audit_events WHERE resource_kind='task')`).Scan(&records, &events); err != nil || records != 0 || events != 0 {
				t.Fatal("rejected raced write retained changes", err)
			}
		})
	}
}
