//go:build integration

package integration

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/planning"
	"github.com/theroisey/else/backend/internal/tasks"
)

func TestPlanningHTTPStrictInputsCSRFAndSafeAudit(t *testing.T) {
	f := newPlanningFixture(t)
	path := planPath(clientAID)
	assertStatus(t, f.request(t, nil, "GET", path, nil, nil), 401, "authentication_required")
	for _, alter := range []func(*http.Request){func(r *http.Request) { r.Header.Del("X-CSRF-Token") }, func(r *http.Request) { r.Header.Set("Origin", "https://other.example") }, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }} {
		w := f.request(t, &f.login, "POST", path, planningProfile(), alter)
		if w.Code != 403 && w.Code != 415 {
			t.Fatal("mutation browser boundary bypassed")
		}
	}
	for _, body := range []any{map[string]any{"title": "valid", "created_by": f.actor}, map[string]any{"title": "valid", "client_id": clientBID}, map[string]any{"title": "valid", "status": "active"}, map[string]any{"title": "valid", "completed_at": "2026-10-02T00:00:00Z"}, map[string]any{"title": "a\nb"}, map[string]any{"title": "valid", "due_at": "2026-10-02T12:00:00"}} {
		assertStatus(t, f.request(t, &f.login, "POST", path, body, nil), 400, "invalid_request")
	}
	for _, raw := range []string{`{"title":"valid"} {}`, `null`, strings.Repeat("x", 65537)} {
		assertStatus(t, f.request(t, &f.login, "POST", path, nil, func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(raw)) }), 400, "invalid_request")
	}
	plan := planningMutation(t, f.request(t, &f.login, "POST", path, planningProfile(), nil), 201)
	childPath := path + "/" + plan.ID + "/milestones"
	assertStatus(t, f.request(t, &f.login, "POST", childPath, map[string]any{"title": "valid", "start_at": nil}, nil), 400, "invalid_request")
	child := planningMutation(t, f.request(t, &f.login, "POST", childPath, planning.MilestoneProfile{Title: "Synthetic milestone"}, nil), 201)
	for _, body := range []any{map[string]any{"expected_revision": 1}, map[string]any{"expected_revision": 1, "task_ids": nil}, map[string]any{"expected_revision": 1, "task_ids": []string{plan.ID, plan.ID}}} {
		assertStatus(t, f.request(t, &f.login, "PUT", childPath+"/"+child.ID+"/task-links", body, nil), 400, "invalid_request")
	}
	child = planningMutation(t, f.request(t, &f.login, "PUT", childPath+"/"+child.ID+"/task-links", map[string]any{"expected_revision": 1, "task_ids": []string{}}, nil), 200)
	assertStatus(t, f.request(t, &f.login, "POST", childPath+"/"+child.ID+"/status", map[string]any{"expected_revision": 1, "status": "completed"}, nil), 409, "conflict")
	child = planningMutation(t, f.request(t, &f.login, "POST", childPath+"/"+child.ID+"/status", map[string]any{"expected_revision": child.Revision, "status": "completed"}, nil), 200)
	assertStatus(t, f.request(t, &f.login, "PUT", childPath+"/"+child.ID, map[string]any{"expected_revision": child.Revision, "title": "Changed terminal"}, nil), 409, "conflict")
	assertStatus(t, f.request(t, &f.login, "POST", path+"/"+plan.ID+"/archive", map[string]any{"expected_revision": 1}, nil), 400, "invalid_request")
	planningMutation(t, f.request(t, &f.login, "POST", path+"/"+plan.ID+"/archive", map[string]any{"expected_revision": 1, "confirm": true}, nil), 200)
	for _, query := range []string{"limit=101", "limit=1&limit=2", "status=planned", "cursor=bad", "sort=title", "q=" + strings.Repeat("x", 101)} {
		assertStatus(t, f.request(t, &f.login, "GET", path+"?"+query, nil, nil), 400, "invalid_request")
	}
	assertStatus(t, f.request(t, &f.login, "GET", path+"/"+plan.ID+"?limit=1", nil, nil), 400, "invalid_request")
	assertStatus(t, f.request(t, &f.login, "DELETE", path+"/"+plan.ID, nil, nil), 405, "method_not_allowed")
	var auditText string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT string_agg(before_state::text||after_state::text||metadata::text,'') FROM app.audit_events WHERE resource_kind IN ('plan','milestone')`).Scan(&auditText); err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{planningProfile().Title, planningProfile().Description, "Synthetic milestone", "task_ids", "due_at", "start_at"} {
		if strings.Contains(auditText, private) || strings.Contains(f.logs.String(), private) {
			t.Fatal("planning data escaped into audit or logs")
		}
	}
	if !strings.Contains(auditText, "planning_status") || !strings.Contains(auditText, "completed") {
		t.Fatal("typed planning audit marker missing")
	}
}

func TestPlanningPagesArchivedClientsAndStorageBoundary(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := correlation.New(f.base.ctx)
	var ids []string
	for i := 0; i < 5; i++ {
		p := planningProfile()
		p.Title = "Literal % plan"
		ids = append(ids, f.createPlan(t, "", p).ID)
	}
	filter := planFilter()
	filter.Limit = 2
	filter.Search = "%"
	seen := map[string]bool{}
	for {
		page, err := f.plans.List(ctx, f.actor, clientAID, "", filter)
		if err != nil || len(page.Data) > 2 {
			t.Fatal("bounded page failed", err)
		}
		for _, r := range page.Data {
			if seen[r.ID] {
				t.Fatal("keyset repeated a row")
			}
			seen[r.ID] = true
		}
		if page.Page.NextCursor == nil {
			break
		}
		filter.Cursor = *page.Page.NextCursor
	}
	if len(seen) != 5 {
		t.Fatal("literal search/keyset lost records")
	}
	filter = planFilter()
	filter.Sort = "-id"
	filter.Limit = 1
	desc, err := f.plans.List(ctx, f.actor, clientAID, "", filter)
	if err != nil || len(desc.Data) != 1 {
		t.Fatal(err)
	}
	for id := range seen {
		if id > desc.Data[0].ID {
			t.Fatal("descending ordering failed")
		}
	}
	plan := ids[0]
	child := f.createPlan(t, plan, planningProfile())
	for _, sql := range []string{"SELECT * FROM app.plans", "SELECT * FROM app.milestones", "SELECT * FROM app.milestone_task_links", "UPDATE app.plans SET title='forged'", "DELETE FROM app.milestones", "TRUNCATE app.milestone_task_links", "SELECT app.planning_document(NULL,'" + plan + "',true)", "SELECT app.planning_transition('draft','active',false)"} {
		if _, err := f.runtime.Exec(ctx, sql); err == nil {
			t.Fatal("runtime bypassed planning storage boundary")
		}
	}
	if _, err := f.records.Archive(ctx, f.actor, clientAID, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := f.plans.Detail(ctx, f.actor, clientAID, plan, child.ID); err != nil {
		t.Fatal("archived client history disappeared", err)
	}
	if _, err := f.plans.Create(ctx, f.actor, clientAID, "", planningProfile()); !errors.Is(err, planning.ErrConflict) {
		t.Fatal("archived client accepted plan", err)
	}
	if _, err := f.plans.Archive(ctx, f.actor, clientAID, plan, child.ID, 1); !errors.Is(err, planning.ErrConflict) {
		t.Fatal("archived client accepted milestone write", err)
	}
}

func TestPlanningAuditFailureRollsBackEveryWriteAndLinkHistory(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := correlation.New(f.base.ctx)
	plan := f.createPlan(t, "", planningProfile())
	child := f.createPlan(t, plan.ID, planningProfile())
	task, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
	if err != nil {
		t.Fatal(err)
	}
	child, err = f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, child.ID, 1, []string{task.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.admin.Exec(ctx, "REVOKE INSERT "+auditColumns+" ON app.audit_events FROM "+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	for _, scope := range []struct {
		parent string
		m      planning.Mutation
	}{{"", plan}, {plan.ID, child}} {
		for _, write := range []func() error{func() error {
			_, e := f.plans.Create(ctx, f.actor, clientAID, scope.parent, planningProfile())
			return e
		}, func() error {
			p := planningProfile()
			p.Title = "Failed audit"
			_, e := f.plans.Update(ctx, f.actor, clientAID, scope.parent, scope.m.ID, scope.m.Revision, p)
			return e
		}, func() error {
			state := "active"
			if scope.parent != "" {
				state = "completed"
			}
			_, e := f.plans.Transition(ctx, f.actor, clientAID, scope.parent, scope.m.ID, scope.m.Revision, state)
			return e
		}, func() error {
			_, e := f.plans.Archive(ctx, f.actor, clientAID, scope.parent, scope.m.ID, scope.m.Revision)
			return e
		}} {
			if write() == nil {
				t.Fatal("unaudited planning mutation succeeded")
			}
		}
	}
	if _, err = f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, child.ID, child.Revision, nil); err == nil {
		t.Fatal("unaudited unlink succeeded")
	}
	var plans, milestones, links int
	if err := f.admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM app.plans),(SELECT count(*) FROM app.milestones),(SELECT count(*) FROM app.milestone_task_links WHERE unlinked_at IS NULL)`).Scan(&plans, &milestones, &links); err != nil || plans != 1 || milestones != 1 || links != 1 {
		t.Fatal("audit rollback retained changes", err)
	}
	r, err := f.plans.Detail(ctx, f.actor, clientAID, plan.ID, child.ID)
	if err != nil || r.Revision != child.Revision || r.Status != "planned" || r.ArchivedAt != nil || r.Title != "Synthetic plan" {
		t.Fatal("audit failure rewrote record", err)
	}
}

func TestPlanningConcurrentEditsCommitOneRevisionAndEvent(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := correlation.New(f.base.ctx)
	plan := f.createPlan(t, "", planningProfile())
	child := f.createPlan(t, plan.ID, planningProfile())
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, title := range []string{"Concurrent A", "Concurrent B"} {
		wg.Add(1)
		go func(title string) {
			defer wg.Done()
			p := planningProfile()
			p.Title = title
			_, err := f.plans.Update(ctx, f.actor, clientAID, plan.ID, child.ID, 1, p)
			results <- err
		}(title)
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, planning.ErrConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("concurrent edit lost revision protection")
	}
	var events int
	if err := f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid AND event_name='milestone.updated'`, child.ID).Scan(&events); err != nil || events != 1 {
		t.Fatal("rejected edit emitted audit", err)
	}
}

func TestPlanningWaitsForFreshPermissionsParentsTasksAndDateWindow(t *testing.T) {
	for _, scenario := range []string{"actor revoked", "actor disabled", "client archived", "plan archived", "plan completed", "window changed", "task archived", "task access revoked"} {
		t.Run(scenario, func(t *testing.T) {
			f := newPlanningFixture(t)
			ctx := correlation.New(f.base.ctx)
			plan := f.createPlan(t, "", planningProfile())
			child := f.createPlan(t, plan.ID, planningProfile())
			task, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
			if err != nil {
				t.Fatal(err)
			}
			user, assignment := f.grantPlanning(t, []authorization.Permission{authorization.PlanningView, authorization.PlanningCreate, authorization.PlanningUpdate})
			reader, err := f.accounts.CreateRole(ctx, f.actor, "Race task reader", []authorization.Permission{authorization.TasksView})
			if err != nil {
				t.Fatal(err)
			}
			taskAssignment, err := f.authorizer.AssignRole(ctx, f.actor, user, reader.ID, authorization.Client, clientAID)
			if err != nil {
				t.Fatal(err)
			}
			tx, err := f.admin.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(871092650209)"); err != nil {
				t.Fatal(err)
			}
			want := planning.ErrConflict
			switch scenario {
			case "actor revoked":
				want = planning.ErrMissing
				_, err = tx.Exec(ctx, "UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid", assignment)
			case "actor disabled":
				want = planning.ErrMissing
				_, err = tx.Exec(ctx, "UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid", user)
			case "client archived":
				_, err = tx.Exec(ctx, "UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid", clientAID)
			case "plan archived":
				_, err = tx.Exec(ctx, "UPDATE app.plans SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid", plan.ID)
			case "plan completed":
				_, err = tx.Exec(ctx, "UPDATE app.plans SET status='completed',completed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid", plan.ID)
			case "window changed":
				want = planning.ErrDates
				_, err = tx.Exec(ctx, "UPDATE app.plans SET due_at='2026-10-02T12:00:00Z',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid", plan.ID)
			case "task archived":
				want = planning.ErrLink
				_, err = tx.Exec(ctx, "UPDATE app.tasks SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid", task.ID)
			case "task access revoked":
				want = planning.ErrLink
				_, err = tx.Exec(ctx, "UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid", taskAssignment)
			}
			if err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				if scenario == "window changed" {
					p := planningProfile()
					due := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
					p.DueAt = &due
					_, err := f.plans.Update(ctx, user, clientAID, plan.ID, child.ID, 1, p)
					result <- err
				} else {
					_, err := f.plans.ReplaceLinks(ctx, user, clientAID, plan.ID, child.ID, 1, []string{task.ID})
					result <- err
				}
			}()
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
					t.Fatal("planning write skipped shared lock")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err = <-result; !errors.Is(err, want) {
				t.Fatal("write used stale authorization or lifecycle state", err)
			}
			r, err := f.plans.Detail(ctx, f.actor, clientAID, plan.ID, child.ID)
			if err != nil || r.Revision != 1 || r.DueAt != nil || r.TaskIDs == nil || len(*r.TaskIDs) != 0 {
				t.Fatal("raced write retained changes", err)
			}
			var events int
			if err = f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid`, child.ID).Scan(&events); err != nil || events != 1 {
				t.Fatal("raced write retained audit", err)
			}
		})
	}
}

func TestPlanningAuditDatabaseRejectsUnreviewedStatesAndKinds(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := correlation.New(f.base.ctx)
	for _, input := range []struct{ kind, payload string }{{"plan", `{"planning_status":"planned"}`}, {"milestone", `{"planning_status":"active"}`}, {"client", `{"planning_status":"draft"}`}, {"plan", `{"planning_status":null}`}, {"plan", `{"planning_status":1}`}, {"plan", `{"planning_status":"secret"}`}, {"plan", `{"planning_status":"active","title":"private"}`}} {
		if _, err := f.runtime.Exec(ctx, `INSERT INTO app.audit_events `+auditColumns+` VALUES ('user',$1::uuid,$2,$3,$4::uuid,$5::uuid,$6,'null',$7::jsonb,'{"source":"http"}')`, f.actor, input.kind+".updated", input.kind, fixtureID, clientAID, correlation.ID(ctx), input.payload); err == nil {
			t.Fatal("database allowed unreviewed planning audit")
		}
	}
	state := "active"
	if err := audit.WithTransaction(ctx, f.runtime, func(context.Context, audit.Queries) (audit.Event, error) {
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: f.actor}, Action: audit.Updated, ResourceKind: "plan", ResourceID: fixtureID, ClientID: clientAID, After: &audit.Snapshot{PlanningStatus: &state}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	}); err != nil {
		t.Fatal("valid typed audit rejected", err)
	}
}

func TestPlanningLinkLimitCandidatePagingAndRetainedReferencesAfterRevocation(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := correlation.New(f.base.ctx)
	plan := f.createPlan(t, "", planningProfile())
	child := f.createPlan(t, plan.ID, planningProfile())
	var ids []string
	for i := 0; i < 51; i++ {
		m, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, m.ID)
	}
	if _, err := f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, child.ID, 1, ids); !errors.Is(err, planning.ErrInvalid) {
		t.Fatal("unbounded links accepted", err)
	}
	user, _ := f.grantPlanning(t, []authorization.Permission{authorization.PlanningView, authorization.PlanningUpdate})
	reader, err := f.accounts.CreateRole(ctx, f.actor, "Link task reader", []authorization.Permission{authorization.TasksView})
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := f.authorizer.AssignRole(ctx, f.actor, user, reader.ID, authorization.Client, clientAID)
	if err != nil {
		t.Fatal(err)
	}
	filter := planFilter()
	filter.Limit = 2
	page, err := f.plans.Candidates(ctx, user, clientAID, plan.ID, filter)
	if err != nil || len(page.Data) != 2 || page.Page.NextCursor == nil {
		t.Fatal("candidate page unbounded", err)
	}
	child, err = f.plans.ReplaceLinks(ctx, user, clientAID, plan.ID, child.ID, 1, ids[:50])
	if err != nil {
		t.Fatal("maximum legal link set rejected", err)
	}
	if err = f.authorizer.RevokeRole(ctx, f.actor, assignment); err != nil {
		t.Fatal(err)
	}
	child, err = f.plans.ReplaceLinks(ctx, user, clientAID, plan.ID, child.ID, child.Revision, ids[:50])
	if err != nil {
		t.Fatal("unchanged links required revoked task view", err)
	}
	if _, err = f.plans.ReplaceLinks(ctx, user, clientAID, plan.ID, child.ID, child.Revision, append(ids[:49:49], ids[50])); !errors.Is(err, planning.ErrLink) {
		t.Fatal("new link bypassed revoked task view", err)
	}
	filter = planFilter()
	filter.Limit = 2
	links, err := f.plans.Links(ctx, user, clientAID, plan.ID, child.ID, filter)
	if err != nil || len(links.Data) != 2 || links.Page.NextCursor == nil {
		t.Fatal("link history page unbounded", err)
	}
	if _, err = f.plans.ReplaceLinks(ctx, user, clientAID, plan.ID, child.ID, child.Revision, nil); err != nil {
		t.Fatal("removal required revoked task view", err)
	}
}
