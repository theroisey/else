//go:build integration

package integration

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/tasks"
)

type taskFixture struct {
	*clientFixture
	tasks *tasks.Service
}

func newTaskFixture(t *testing.T) *taskFixture {
	t.Helper()
	f := newClientFixture(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION app.task_read(uuid,uuid,uuid),
 app.task_list(uuid,uuid,uuid,integer,text,text,uuid,boolean,text,text,text,boolean),
 app.task_assignees(uuid,uuid,uuid,integer),app.task_write(uuid,uuid,uuid,bigint,text,jsonb,text) TO `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	service, err := tasks.NewService(f.runtime)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(f.logs, nil))
	auth, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := tasks.NewHandler(service, auth, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = httpapi.RequestMiddleware(logger, handler)
	return &taskFixture{f, service}
}
func taskProfile() tasks.Profile {
	return tasks.Profile{Title: "Synthetic task", Description: "Synthetic private task\nSecond line", Priority: "high", Tags: []string{"synthetic", "work"}}
}
func taskPath(client string) string { return "clients/" + client + "/tasks" }
func taskMutation(t *testing.T, w *httptest.ResponseRecorder, status int) tasks.Mutation {
	t.Helper()
	assertStatus(t, w, status, "")
	var envelope struct {
		Data tasks.Mutation `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil || envelope.Data.ID == "" {
		t.Fatal("missing mutation", err)
	}
	return envelope.Data
}
func (f *taskFixture) create(t *testing.T, client string, input tasks.CreateInput) tasks.Mutation {
	t.Helper()
	return taskMutation(t, f.request(t, &f.login, "POST", taskPath(client), input, nil), 201)
}
func (f *taskFixture) status(t *testing.T, client string, m tasks.Mutation, status string) tasks.Mutation {
	t.Helper()
	return taskMutation(t, f.request(t, &f.login, "POST", taskPath(client)+"/"+m.ID+"/status", map[string]any{"status": status, "expected_revision": m.Revision}, nil), 200)
}
func TestTaskHTTPTransitionsTimestampsArchiveAndSafeAudit(t *testing.T) {
	f := newTaskFixture(t)
	ctx := correlation.New(f.base.ctx)
	start := time.Now().Add(time.Hour).UTC().Truncate(time.Microsecond)
	due := start.Add(time.Hour)
	p := taskProfile()
	p.StartAt = &start
	p.DueAt = &due
	p.AssigneeID = &f.actor
	m := f.create(t, clientAID, tasks.CreateInput{Profile: p})
	path := taskPath(clientAID) + "/" + m.ID
	m = f.status(t, clientAID, m, "in_progress")
	m = f.status(t, clientAID, m, "review")
	m = f.status(t, clientAID, m, "done")
	detail, err := f.tasks.Detail(ctx, f.actor, clientAID, m.ID)
	if err != nil || detail.Status != "done" || detail.CompletedAt == nil || detail.CancelledAt != nil || !detail.StartAt.Equal(start) || !detail.DueAt.Equal(due) || detail.CreatedBy != f.actor || detail.AssigneeID == nil || *detail.AssigneeID != f.actor {
		t.Fatal("completion or ownership contract failed", err)
	}
	assertStatus(t, f.request(t, &f.login, "PUT", path, map[string]any{"title": "terminal edit", "expected_revision": m.Revision}, nil), 409, "conflict")
	assertStatus(t, f.request(t, &f.login, "POST", path+"/status", map[string]any{"status": "done", "expected_revision": m.Revision}, nil), 409, "invalid_transition")
	m = f.status(t, clientAID, m, "in_progress")
	detail, err = f.tasks.Detail(ctx, f.actor, clientAID, m.ID)
	if err != nil || detail.CompletedAt != nil {
		t.Fatal("reopen retained completion timestamp", err)
	}
	m = f.status(t, clientAID, m, "cancelled")
	detail, err = f.tasks.Detail(ctx, f.actor, clientAID, m.ID)
	if err != nil || detail.CancelledAt == nil || detail.CompletedAt != nil {
		t.Fatal("cancellation timestamp failed", err)
	}
	m = f.status(t, clientAID, m, "todo")
	detail, err = f.tasks.Detail(ctx, f.actor, clientAID, m.ID)
	if err != nil || detail.CancelledAt != nil {
		t.Fatal("reopen retained cancellation timestamp", err)
	}
	body := map[string]any{"title": "Synthetic updated task", "description": p.Description, "priority": "urgent", "tags": []string{"replaced"}, "expected_revision": m.Revision}
	m = taskMutation(t, f.request(t, &f.login, "PUT", path, body, nil), 200)
	assertStatus(t, f.request(t, &f.login, "PUT", path, body, nil), 409, "conflict")
	m = f.status(t, clientAID, m, "in_progress")
	m = f.status(t, clientAID, m, "done")
	detail, err = f.tasks.Detail(ctx, f.actor, clientAID, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	completed := *detail.CompletedAt
	m = taskMutation(t, f.request(t, &f.login, "POST", path+"/archive", map[string]any{"expected_revision": m.Revision, "confirm": true}, nil), 200)
	detail, err = f.tasks.Detail(ctx, f.actor, clientAID, m.ID)
	if err != nil || detail.ArchivedAt == nil || detail.Status != "done" || !detail.CompletedAt.Equal(completed) || len(detail.Tags) != 1 || detail.Tags[0] != "replaced" || detail.Description != p.Description {
		t.Fatal("archive lost history", err)
	}
	for _, archived := range []string{"false", "true", "all"} {
		page, err := f.tasks.List(ctx, f.actor, clientAID, tasks.Filter{Limit: 25, Status: "done", Priority: "all", Archived: archived, Sort: "id"})
		want := 1
		if archived == "false" {
			want = 0
		}
		if err != nil || len(page.Data) != want {
			t.Fatal("archive filter lost historical task", err)
		}
	}
	assertStatus(t, f.request(t, &f.login, "POST", path+"/status", map[string]any{"status": "in_progress", "expected_revision": m.Revision}, nil), 409, "conflict")
	var events, unsafe int
	var names string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT count(*),count(*) FILTER(WHERE client_id<>$2::uuid OR actor_user_id<>$3::uuid OR
 after_state-ARRAY['exists','revision','task_status']<>'{}'::jsonb OR after_state::text LIKE '%Synthetic%' OR before_state::text LIKE '%assignee%'),
 string_agg(event_name,',' ORDER BY occurred_at) FROM app.audit_events WHERE resource_kind='task' AND resource_id=$1::uuid`, m.ID, clientAID, f.actor).Scan(&events, &unsafe, &names); err != nil || events != int(m.Revision) || unsafe != 0 {
		t.Fatal("safe atomic events failed", err)
	}
	if names != "task.created,task.updated,task.updated,task.completed,task.updated,task.cancelled,task.updated,task.updated,task.updated,task.completed,task.archived" {
		t.Fatal("incorrect task events")
	}
	for _, v := range []string{p.Title, p.Description, m.ID, clientAID} {
		if strings.Contains(f.logs.String(), v) {
			t.Fatal("task values leaked in logs")
		}
	}
}
func TestTaskEntireTransitionMatrix(t *testing.T) {
	f := newTaskFixture(t)
	states := []string{"backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled"}
	allowed := map[string][]string{"backlog": {"todo", "cancelled"}, "todo": {"backlog", "in_progress", "blocked", "cancelled"}, "in_progress": {"todo", "blocked", "review", "done", "cancelled"}, "blocked": {"todo", "in_progress", "cancelled"}, "review": {"in_progress", "blocked", "done", "cancelled"}, "done": {"in_progress"}, "cancelled": {"backlog", "todo"}}
	paths := map[string][]string{"backlog": {}, "todo": {"todo"}, "in_progress": {"todo", "in_progress"}, "blocked": {"todo", "blocked"}, "review": {"todo", "in_progress", "review"}, "done": {"todo", "in_progress", "done"}, "cancelled": {"cancelled"}}
	for _, previous := range states {
		for _, next := range states {
			t.Run(previous+"_to_"+next, func(t *testing.T) {
				m := f.create(t, clientAID, tasks.CreateInput{Profile: taskProfile(), Status: "backlog"})
				for _, step := range paths[previous] {
					m = f.status(t, clientAID, m, step)
				}
				legal := false
				for _, v := range allowed[previous] {
					if v == next {
						legal = true
					}
				}
				w := f.request(t, &f.login, "POST", taskPath(clientAID)+"/"+m.ID+"/status", map[string]any{"status": next, "expected_revision": m.Revision}, nil)
				wantState, wantRevision := previous, m.Revision
				if legal {
					m = taskMutation(t, w, 200)
					wantState, wantRevision = next, m.Revision
				} else {
					assertStatus(t, w, 409, "invalid_transition")
				}
				detail, err := f.tasks.Detail(f.base.ctx, f.actor, clientAID, m.ID)
				if err != nil || detail.Status != wantState || detail.Revision != wantRevision || (detail.CompletedAt != nil) != (wantState == "done") || (detail.CancelledAt != nil) != (wantState == "cancelled") {
					t.Fatal("state or timestamp mismatch", err)
				}
				var events int
				if err := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.audit_events WHERE resource_kind='task' AND resource_id=$1::uuid`, m.ID).Scan(&events); err != nil || int64(events) != wantRevision {
					t.Fatal("transition event/revision mismatch", err)
				}
			})
		}
	}
}
func TestTaskAuditFailureRollsBackAndRuntimeStorageIsPrivate(t *testing.T) {
	f := newTaskFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.create(t, clientAID, tasks.CreateInput{Profile: taskProfile()})
	m = f.status(t, clientAID, m, "in_progress")
	for _, sql := range []string{"SELECT * FROM app.tasks", "SELECT * FROM app.task_tags", "UPDATE app.tasks SET title='forged'", "DELETE FROM app.tasks", "TRUNCATE app.tasks",
		"SELECT app.task_document('" + m.ID + "',true)", "SELECT app.task_allowed('" + f.actor + "','tasks.update','" + clientAID + "')", "SELECT app.task_transition('todo','done')"} {
		if _, err := f.runtime.Exec(f.base.ctx, sql); err == nil {
			t.Fatal("runtime bypassed task boundary")
		}
	}
	if _, err := f.admin.Exec(f.base.ctx, "REVOKE INSERT "+auditColumns+" ON app.audit_events FROM "+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	p := taskProfile()
	p.Title = "Failed audit task"
	p.Tags = []string{"failed"}
	for _, write := range []func() error{
		func() error {
			_, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: p})
			return err
		},
		func() error { _, err := f.tasks.Update(ctx, f.actor, clientAID, m.ID, m.Revision, p); return err },
		func() error {
			_, err := f.tasks.Transition(ctx, f.actor, clientAID, m.ID, m.Revision, "done")
			return err
		},
		func() error { _, err := f.tasks.Archive(ctx, f.actor, clientAID, m.ID, m.Revision); return err },
	} {
		if err := write(); err == nil {
			t.Fatal("unaudited task write succeeded")
		}
	}
	detail, err := f.tasks.Detail(ctx, f.actor, clientAID, m.ID)
	if err != nil || detail.Revision != m.Revision || detail.Title != "Synthetic task" || detail.Status != "in_progress" || detail.CompletedAt != nil || detail.ArchivedAt != nil || len(detail.Tags) != 2 {
		t.Fatal("audit failure retained task changes", err)
	}
	var count int
	if err := f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app.tasks").Scan(&count); err != nil || count != 1 {
		t.Fatal("failed audit retained new task", err)
	}
}
func TestTaskBoundedPagesFiltersAndArchivedParent(t *testing.T) {
	f := newTaskFixture(t)
	ctx := correlation.New(f.base.ctx)
	ids := map[string]bool{}
	for i := 0; i < 3; i++ {
		p := taskProfile()
		p.Title = fmt.Sprintf("Synthetic task %d", i)
		if i == 2 {
			p.AssigneeID = &f.actor
			p.Priority = "urgent"
		}
		m := f.create(t, clientAID, tasks.CreateInput{Profile: p})
		ids[m.ID] = true
	}
	f.create(t, clientBID, tasks.CreateInput{Profile: taskProfile()})
	for _, sort := range []string{"id", "-id"} {
		cursor := ""
		seen := map[string]bool{}
		last := ""
		for {
			query := "?limit=1&sort=" + sort
			if cursor != "" {
				query += "&cursor=" + cursor
			}
			w := f.request(t, &f.login, "GET", taskPath(clientAID)+query, nil, nil)
			assertStatus(t, w, 200, "")
			var page tasks.Page[tasks.Summary]
			if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Data) != 1 || page.Page.Limit != 1 {
				t.Fatal("pagination failed", err)
			}
			item := page.Data[0]
			if !ids[item.ID] || seen[item.ID] || (last != "" && ((sort == "id" && item.ID <= last) || (sort == "-id" && item.ID >= last))) || strings.Contains(w.Body.String(), "description") {
				t.Fatal("list isolation/order/summary failed")
			}
			seen[item.ID] = true
			last = item.ID
			if page.Page.NextCursor == nil {
				break
			}
			cursor = *page.Page.NextCursor
		}
		if len(seen) != 3 {
			t.Fatal("pagination lost tasks")
		}
	}
	for query, want := range map[string]int{"status=todo": 3, "status=done": 0, "priority=urgent": 1, "assignee=" + f.actor: 1, "assignee=unassigned": 2, "tag=work&q=Synthetic": 3, "q=%25": 0, "tag=missing": 0, "archived=true": 0} {
		w := f.request(t, &f.login, "GET", taskPath(clientAID)+"?"+query, nil, nil)
		assertStatus(t, w, 200, "")
		var page tasks.Page[tasks.Summary]
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Data) != want {
			t.Fatalf("filter %s failed: %v", query, err)
		}
	}
	if _, err := f.records.Archive(ctx, f.actor, clientAID, 1); err != nil {
		t.Fatal(err)
	}
	for id := range ids {
		if _, err := f.tasks.Detail(ctx, f.actor, clientAID, id); err != nil {
			t.Fatal("archived parent lost history", err)
		}
		for _, write := range []func() error{func() error { _, err := f.tasks.Update(ctx, f.actor, clientAID, id, 1, taskProfile()); return err }, func() error { _, err := f.tasks.Transition(ctx, f.actor, clientAID, id, 1, "in_progress"); return err }, func() error { _, err := f.tasks.Archive(ctx, f.actor, clientAID, id, 1); return err }} {
			if err := write(); !errors.Is(err, tasks.ErrConflict) {
				t.Fatal("archived parent accepted write", err)
			}
		}
	}
	if _, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()}); !errors.Is(err, tasks.ErrConflict) {
		t.Fatal("archived parent accepted create", err)
	}
	assertStatus(t, f.request(t, &f.login, "GET", taskPath(clientAID), nil, nil), 200, "")
	assertStatus(t, f.request(t, &f.login, "GET", taskPath(clientAID)+"/assignees", nil, nil), 409, "conflict")
}
func TestTaskHTTPAuthenticationCSRFAndStrictInputs(t *testing.T) {
	f := newTaskFixture(t)
	path := taskPath(clientAID)
	assertStatus(t, f.request(t, nil, "GET", path, nil, nil), 401, "authentication_required")
	for _, alter := range []func(*http.Request){func(r *http.Request) { r.Header.Set("Origin", "https://other.example") }, func(r *http.Request) { r.Header.Del("X-CSRF-Token") }, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }} {
		w := f.request(t, &f.login, "POST", path, tasks.CreateInput{Profile: taskProfile()}, alter)
		if w.Code != 403 && w.Code != 415 {
			t.Fatal("mutation browser boundary bypassed")
		}
	}
	for _, input := range []any{map[string]any{"title": "bad\nname"}, map[string]any{"title": "Synthetic", "created_by": f.actor}, map[string]any{"title": "Synthetic", "completed_at": "2026-10-01T09:00:00Z"}, map[string]any{"title": "Synthetic", "status": "done"}, map[string]any{"title": "Synthetic", "priority": "critical"}, map[string]any{"title": "Synthetic", "start_at": "2026-10-01T09:00:00"}} {
		assertStatus(t, f.request(t, &f.login, "POST", path, input, nil), 400, "invalid_request")
	}
	for _, query := range []string{"limit=101", "limit=1&limit=2", "cursor=bad", "status=deleted", "sort=unsafe", "q=" + strings.Repeat("x", 101)} {
		assertStatus(t, f.request(t, &f.login, "GET", path+"?"+query, nil, nil), 400, "invalid_request")
	}
	m := f.create(t, clientAID, tasks.CreateInput{Profile: taskProfile()})
	assertStatus(t, f.request(t, &f.login, "PUT", path+"/"+m.ID, map[string]any{"title": "ok", "status": "done", "expected_revision": 1}, nil), 400, "invalid_request")
	assertStatus(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/archive", map[string]any{"expected_revision": 1}, nil), 400, "invalid_request")
	assertStatus(t, f.request(t, &f.login, "GET", path+"/"+m.ID+"?unexpected=x", nil, nil), 400, "invalid_request")
	assertStatus(t, f.request(t, &f.login, "DELETE", path+"/"+m.ID, nil, nil), 405, "method_not_allowed")
}
