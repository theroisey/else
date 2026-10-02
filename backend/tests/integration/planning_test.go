//go:build integration

package integration

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/planning"
	"github.com/theroisey/else/backend/internal/tasks"
)

type planningFixture struct {
	*taskFixture
	plans *planning.Service
}

func newPlanningFixture(t *testing.T) *planningFixture {
	t.Helper()
	f := newTaskFixture(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION app.planning_read(uuid,uuid,uuid,uuid),app.planning_list(uuid,uuid,uuid,uuid,integer,text,text,text,boolean),app.planning_links(uuid,uuid,uuid,uuid,uuid,integer,text,boolean),app.planning_task_candidates(uuid,uuid,uuid,uuid,integer,text,boolean),app.planning_write(uuid,uuid,uuid,uuid,bigint,text,jsonb,text,jsonb) TO `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	s, err := planning.NewService(f.runtime)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(f.logs, nil))
	auth, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	h, err := planning.NewHandler(s, auth, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = httpapi.RequestMiddleware(logger, h)
	return &planningFixture{f, s}
}
func planningProfile() planning.Profile {
	return planning.Profile{Title: "Synthetic plan", Description: "Synthetic private planning text\nSecond line"}
}
func planPath(client string) string { return "clients/" + client + "/plans" }
func planningMutation(t *testing.T, w *httptest.ResponseRecorder, status int) planning.Mutation {
	t.Helper()
	assertStatus(t, w, status, "")
	var e struct {
		Data planning.Mutation `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil || e.Data.ID == "" {
		t.Fatal("missing planning mutation", err)
	}
	return e.Data
}
func (f *planningFixture) createPlan(t *testing.T, parent string, p planning.Profile) planning.Mutation {
	t.Helper()
	m, err := f.plans.Create(correlation.New(f.base.ctx), f.actor, clientAID, parent, p)
	if err != nil {
		t.Fatal(err)
	}
	return m
}
func planFilter() planning.Filter {
	return planning.Filter{Limit: 25, Status: "all", Archived: "false", Sort: "id"}
}
func (f *planningFixture) grantPlanning(t *testing.T, permissions []authorization.Permission) (string, string) {
	t.Helper()
	ctx := correlation.New(f.base.ctx)
	user := f.user(t, fmt.Sprintf("planning-%d@example.com", time.Now().UnixNano()))
	if len(permissions) == 0 {
		return user.ID, ""
	}
	role, err := f.accounts.CreateRole(ctx, f.actor, fmt.Sprintf("Planning role %d", time.Now().UnixNano()), permissions)
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := f.authorizer.AssignRole(ctx, f.actor, user.ID, role.ID, authorization.Client, clientAID)
	if err != nil {
		t.Fatal(err)
	}
	return user.ID, assignment
}

func TestPlanningEntireStateMatricesAndServerMarkers(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := correlation.New(f.base.ctx)
	parent := f.createPlan(t, "", planningProfile())
	for _, milestone := range []bool{false, true} {
		states := []string{"draft", "active", "completed", "cancelled"}
		scope := ""
		if milestone {
			states = []string{"planned", "in_progress", "completed", "cancelled"}
			scope = parent.ID
		}
		for _, from := range states {
			for _, to := range states {
				m := f.createPlan(t, scope, planningProfile())
				initial := states[0]
				if from != initial {
					if !milestone && from == "completed" {
						var err error
						m, err = f.plans.Transition(ctx, f.actor, clientAID, scope, m.ID, m.Revision, "active")
						if err != nil {
							t.Fatal(err)
						}
					}
					var err error
					m, err = f.plans.Transition(ctx, f.actor, clientAID, scope, m.ID, m.Revision, from)
					if err != nil {
						t.Fatal(err)
					}
				}
				allowed := false
				if milestone {
					allowed = (from == "planned" && to != "planned") || (from == "in_progress" && to != "in_progress") || (from == "completed" && to == "in_progress") || (from == "cancelled" && (to == "planned" || to == "in_progress"))
				} else {
					allowed = (from == "draft" && (to == "active" || to == "cancelled")) || (from == "active" && to != "active") || (from == "completed" && to == "active") || (from == "cancelled" && (to == "draft" || to == "active"))
				}
				before := m.Revision
				next, err := f.plans.Transition(ctx, f.actor, clientAID, scope, m.ID, m.Revision, to)
				if allowed {
					if err != nil || next.Revision != before+1 {
						t.Fatal("valid transition rejected", milestone, from, to, err)
					}
					m = next
				} else if !errors.Is(err, planning.ErrTransition) {
					t.Fatal("invalid transition accepted", milestone, from, to, err)
				}
				r, err := f.plans.Detail(ctx, f.actor, clientAID, scope, m.ID)
				if err != nil || r.Revision != m.Revision || (allowed && r.Status != to) || (!allowed && r.Status != from) || (r.CompletedAt != nil) != (r.Status == "completed") || (r.CancelledAt != nil) != (r.Status == "cancelled") {
					t.Fatal("state or server markers disagree", err)
				}
				var events int
				if err := f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid`, m.ID).Scan(&events); err != nil || int64(events) != m.Revision {
					t.Fatal("transition event not atomic", err)
				}
			}
		}
	}
	if r, err := f.plans.Detail(ctx, f.actor, clientAID, "", parent.ID); err != nil || r.Revision != 1 || r.Status != "draft" {
		t.Fatal("milestone writes changed their parent", err)
	}
}

func TestPlanningDateWindowsAndTerminalParent(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := correlation.New(f.base.ctx)
	start := time.Date(2026, 10, 2, 12, 0, 0, 123456789, time.FixedZone("offset", 3600))
	due := start.Add(2 * time.Hour)
	p := planningProfile()
	p.StartAt = &start
	p.DueAt = &due
	plan := f.createPlan(t, "", p)
	r, err := f.plans.Detail(ctx, f.actor, clientAID, "", plan.ID)
	if err != nil || r.CreatedBy != f.actor || !r.StartAt.Equal(start.UTC().Truncate(time.Microsecond)) || r.StartAt.Nanosecond() != 123456000 {
		t.Fatal("dates or authorship were not normalized", err)
	}
	child := planningProfile()
	child.DueAt = &start
	early := f.createPlan(t, plan.ID, child)
	child.DueAt = &due
	late := f.createPlan(t, plan.ID, child)
	for _, d := range []time.Time{start.Add(-time.Microsecond), due.Add(time.Microsecond)} {
		child.DueAt = &d
		if _, err := f.plans.Create(ctx, f.actor, clientAID, plan.ID, child); !errors.Is(err, planning.ErrDates) {
			t.Fatal("out of window milestone accepted", err)
		}
	}
	narrow := p
	newStart := start.Add(time.Hour)
	narrow.StartAt = &newStart
	if _, err := f.plans.Update(ctx, f.actor, clientAID, "", plan.ID, 1, narrow); !errors.Is(err, planning.ErrDates) {
		t.Fatal("plan update stranded an active milestone", err)
	}
	if _, err := f.plans.Archive(ctx, f.actor, clientAID, plan.ID, early.ID, 1); err != nil {
		t.Fatal(err)
	}
	plan, err = f.plans.Update(ctx, f.actor, clientAID, "", plan.ID, 1, narrow)
	if err != nil {
		t.Fatal("archived milestone prevented date edit", err)
	}
	plan, err = f.plans.Transition(ctx, f.actor, clientAID, "", plan.ID, plan.Revision, "active")
	if err != nil {
		t.Fatal(err)
	}
	plan, err = f.plans.Transition(ctx, f.actor, clientAID, "", plan.ID, plan.Revision, "completed")
	if err != nil {
		t.Fatal("manual plan completion should not inspect child progress", err)
	}
	for _, write := range []func() error{func() error { _, e := f.plans.Create(ctx, f.actor, clientAID, plan.ID, planningProfile()); return e }, func() error {
		_, e := f.plans.Update(ctx, f.actor, clientAID, plan.ID, late.ID, 1, planningProfile())
		return e
	}, func() error {
		_, e := f.plans.Transition(ctx, f.actor, clientAID, plan.ID, late.ID, 1, "completed")
		return e
	}, func() error { _, e := f.plans.Archive(ctx, f.actor, clientAID, plan.ID, late.ID, 1); return e }, func() error {
		_, e := f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, late.ID, 1, nil)
		return e
	}, func() error { _, e := f.plans.Update(ctx, f.actor, clientAID, "", plan.ID, plan.Revision, p); return e }} {
		if !errors.Is(write(), planning.ErrConflict) {
			t.Fatal("terminal parent permitted a write")
		}
	}
	plan, err = f.plans.Transition(ctx, f.actor, clientAID, "", plan.ID, plan.Revision, "active")
	if err != nil {
		t.Fatal(err)
	}
	if r, err = f.plans.Detail(ctx, f.actor, clientAID, "", plan.ID); err != nil || r.CompletedAt != nil {
		t.Fatal("reopening retained completion timestamp", err)
	}
	plan, err = f.plans.Archive(ctx, f.actor, clientAID, "", plan.ID, plan.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.plans.Create(ctx, f.actor, clientAID, plan.ID, planningProfile()); !errors.Is(err, planning.ErrConflict) {
		t.Fatal("archived plan accepted a milestone", err)
	}
	if childRecord, err := f.plans.Detail(ctx, f.actor, clientAID, plan.ID, late.ID); err != nil || childRecord.Revision != 1 || childRecord.ArchivedAt != nil {
		t.Fatal("plan archive rewrote child history", err)
	}
}

func TestPlanningLinkHistoryTaskPrivacyAndCrossClientIsolation(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := correlation.New(f.base.ctx)
	plan := f.createPlan(t, "", planningProfile())
	child := f.createPlan(t, plan.ID, planningProfile())
	second := f.createPlan(t, plan.ID, planningProfile())
	task, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := f.tasks.Create(ctx, f.actor, clientBID, tasks.CreateInput{Profile: taskProfile()})
	if err != nil {
		t.Fatal(err)
	}
	user, _ := f.grantPlanning(t, []authorization.Permission{authorization.PlanningView, authorization.PlanningUpdate})
	if _, err = f.plans.ReplaceLinks(ctx, user, clientAID, plan.ID, child.ID, 1, []string{task.ID}); !errors.Is(err, planning.ErrLink) {
		t.Fatal("new link bypassed task access", err)
	}
	if _, err = f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, child.ID, 1, []string{foreign.ID}); !errors.Is(err, planning.ErrLink) {
		t.Fatal("foreign link accepted", err)
	}
	child, err = f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, child.ID, 1, []string{task.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, second.ID, 1, []string{task.ID}); err != nil {
		t.Fatal("same task could not link to another milestone", err)
	}
	if _, err = f.tasks.Archive(ctx, f.actor, clientAID, task.ID, task.Revision); err != nil {
		t.Fatal(err)
	}
	privateActor, _ := f.grantPlanning(t, []authorization.Permission{authorization.PlanningView, authorization.PlanningUpdate})
	child, err = f.plans.ReplaceLinks(ctx, privateActor, clientAID, plan.ID, child.ID, child.Revision, []string{task.ID})
	if err != nil {
		t.Fatal("unchanged historical link required task permission", err)
	}
	r, err := f.plans.Detail(ctx, privateActor, clientAID, plan.ID, child.ID)
	if err != nil || r.TaskIDs == nil || len(*r.TaskIDs) != 1 || (*r.TaskIDs)[0] != task.ID {
		t.Fatal("planning history was lost", err)
	}
	login, err := f.service.Login(ctx, func() string {
		var email string
		_ = f.admin.QueryRow(ctx, "SELECT email FROM app.users WHERE id=$1::uuid", privateActor).Scan(&email)
		return email
	}(), bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	path := planPath(clientAID) + "/" + plan.ID + "/milestones/" + child.ID
	w := f.request(t, &login, "GET", path+"/task-links", nil, nil)
	assertStatus(t, w, 200, "")
	if strings.Contains(w.Body.String(), "title") || strings.Contains(w.Body.String(), "status") || strings.Contains(w.Body.String(), "description") {
		t.Fatal("link reads exposed task data")
	}
	if _, err = f.plans.Candidates(ctx, privateActor, clientAID, plan.ID, planFilter()); !errors.Is(err, planning.ErrMissing) {
		t.Fatal("candidates bypassed task access", err)
	}
	child, err = f.plans.ReplaceLinks(ctx, privateActor, clientAID, plan.ID, child.ID, child.Revision, nil)
	if err != nil {
		t.Fatal("removal required task access", err)
	}
	if _, err = f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, child.ID, child.Revision, []string{task.ID}); !errors.Is(err, planning.ErrLink) {
		t.Fatal("relinking archived task was accepted", err)
	}
	active, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
	if err != nil {
		t.Fatal(err)
	}
	child, err = f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, child.ID, child.Revision, []string{active.ID})
	if err != nil {
		t.Fatal(err)
	}
	child, err = f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, child.ID, child.Revision, nil)
	if err != nil {
		t.Fatal(err)
	}
	child, err = f.plans.ReplaceLinks(ctx, f.actor, clientAID, plan.ID, child.ID, child.Revision, []string{active.ID})
	if err != nil {
		t.Fatal(err)
	}
	filter := planFilter()
	filter.Archived = "all"
	links, err := f.plans.Links(ctx, privateActor, clientAID, plan.ID, child.ID, filter)
	if err != nil || len(links.Data) != 3 {
		t.Fatal("unlink/relink rewrote history", err)
	}
	removed := 0
	for _, l := range links.Data {
		if l.UnlinkedAt != nil {
			removed++
		}
	}
	if removed != 2 {
		t.Fatal("history markers missing")
	}
	w = f.request(t, &f.login, "GET", planPath(clientAID)+"/"+plan.ID+"/task-candidates", nil, nil)
	assertStatus(t, w, 200, "")
	var candidatePage struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &candidatePage); err != nil || len(candidatePage.Data) != 1 || len(candidatePage.Data[0]) != 3 || candidatePage.Data[0]["id"] != active.ID {
		t.Fatal("candidate payload or client boundary changed", err)
	}
	if tr, err := f.tasks.Detail(ctx, f.actor, clientAID, active.ID); err != nil || tr.Revision != 1 || tr.Status != "todo" {
		t.Fatal("link changes rewrote task state", err)
	}
	for _, scope := range []struct{ client, parent, target string }{{clientBID, plan.ID, child.ID}, {clientAID, foreign.ID, child.ID}, {clientAID, plan.ID, second.ID}} {
		if scope.target == second.ID {
			scope.parent = foreign.ID
		}
		if _, err := f.plans.Detail(ctx, privateActor, scope.client, scope.parent, scope.target); !errors.Is(err, planning.ErrMissing) {
			t.Fatal("foreign record was visible", err)
		}
	}
}

func TestPlanningExactScopeViewAlongsideWritesAndAuthorship(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := correlation.New(f.base.ctx)
	for _, permissions := range [][]authorization.Permission{{}, {authorization.PlanningCreate}, {authorization.PlanningUpdate}, {authorization.PlanningArchive}, {authorization.PlanningView}, {authorization.PlanningView, authorization.PlanningCreate}, {authorization.PlanningView, authorization.PlanningUpdate}, {authorization.PlanningView, authorization.PlanningArchive}} {
		user, _ := f.grantPlanning(t, permissions)
		p := f.createPlan(t, "", planningProfile())
		has := func(k authorization.Permission) bool {
			for _, v := range permissions {
				if v == k {
					return true
				}
			}
			return false
		}
		_, e := f.plans.Detail(ctx, user, clientAID, "", p.ID)
		if (e == nil) != has(authorization.PlanningView) {
			t.Fatal("view boundary failed", e)
		}
		created, e := f.plans.Create(ctx, user, clientAID, "", planningProfile())
		if (e == nil) != (has(authorization.PlanningView) && has(authorization.PlanningCreate)) {
			t.Fatal("create boundary failed", e)
		}
		if e == nil {
			if r, e := f.plans.Detail(ctx, f.actor, clientAID, "", created.ID); e != nil || r.CreatedBy != user {
				t.Fatal("authorship was not server owned", e)
			}
		}
		m, e := f.plans.Update(ctx, user, clientAID, "", p.ID, 1, planningProfile())
		if (e == nil) != (has(authorization.PlanningView) && has(authorization.PlanningUpdate)) {
			t.Fatal("update boundary failed", e)
		}
		if e == nil {
			p = m
		}
		m, e = f.plans.Transition(ctx, user, clientAID, "", p.ID, p.Revision, "active")
		if (e == nil) != (has(authorization.PlanningView) && has(authorization.PlanningUpdate)) {
			t.Fatal("status boundary failed", e)
		}
		if e == nil {
			p = m
		}
		_, e = f.plans.Archive(ctx, user, clientAID, "", p.ID, p.Revision)
		if (e == nil) != (has(authorization.PlanningView) && has(authorization.PlanningArchive)) {
			t.Fatal("archive boundary failed", e)
		}
		if _, e = f.plans.Create(ctx, user, clientBID, "", planningProfile()); !errors.Is(e, planning.ErrMissing) {
			t.Fatal("scoped role granted another client", e)
		}
	}
	creator, assignment := f.grantPlanning(t, []authorization.Permission{authorization.PlanningView, authorization.PlanningCreate})
	p, e := f.plans.Create(ctx, creator, clientAID, "", planningProfile())
	if e != nil {
		t.Fatal(e)
	}
	if e = f.authorizer.RevokeRole(ctx, f.actor, assignment); e != nil {
		t.Fatal(e)
	}
	if _, e = f.plans.Detail(ctx, creator, clientAID, "", p.ID); !errors.Is(e, planning.ErrMissing) {
		t.Fatal("historical authorship conferred access", e)
	}
}
