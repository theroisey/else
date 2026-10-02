//go:build integration

package integration

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/reminders"
	"github.com/theroisey/else/backend/internal/tasks"
)

type reminderFixture struct {
	*planningFixture
	reminders *reminders.Service
}

func newReminderFixture(t *testing.T) *reminderFixture {
	t.Helper()
	f := newPlanningFixture(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION app.reminder_read(uuid,uuid,uuid),app.reminder_list(uuid,uuid,uuid,integer,text,text,uuid,text,boolean),app.reminder_owners(uuid,uuid,uuid,integer),app.reminder_write(uuid,uuid,uuid,bigint,text,jsonb) TO `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	s, err := reminders.NewService(f.runtime)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(f.logs, nil))
	auth, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	h, err := reminders.NewHandler(s, auth, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = httpapi.RequestMiddleware(logger, h)
	return &reminderFixture{f, s}
}
func reminderProfile() reminders.Profile {
	offset := 0
	return reminders.Profile{Title: "Synthetic reminder", Description: "Synthetic private reminder text", ScheduledLocal: "2026-10-02T12:00:00.123456", Timezone: "UTC", UTCOffsetSeconds: &offset}
}
func reminderFilter() reminders.Filter {
	return reminders.Filter{Limit: 25, Status: "all", Due: "all", Owner: "any", Sort: "id"}
}
func (f *reminderFixture) createReminder(t *testing.T, p reminders.Profile) reminders.Mutation {
	t.Helper()
	m, err := f.reminders.Create(correlation.New(f.base.ctx), f.actor, clientAID, p)
	if err != nil {
		t.Fatal(err)
	}
	return m
}
func TestReminderCreatesExplicitScheduleAndSafeAtomicAudit(t *testing.T) {
	f := newReminderFixture(t)
	m := f.createReminder(t, reminderProfile())
	r, err := f.reminders.Detail(f.base.ctx, f.actor, clientAID, m.ID)
	if err != nil || r.Revision != 1 || r.OwnerID != f.actor || r.CreatedBy != f.actor || r.Status != "pending" || r.ScheduledAt.Format("2006-01-02T15:04:05.999999Z07:00") != "2026-10-02T12:00:00.123456Z" {
		t.Fatal("reminder intent not preserved", r, err)
	}
	var raw []byte
	if err := f.admin.QueryRow(f.base.ctx, `SELECT after_state FROM app.audit_events WHERE resource_id=$1::uuid`, m.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil || len(fields) != 5 || fields["reminder_status"] != "pending" || fields["reminder_timezone"] != "UTC" {
		t.Fatal("unsafe reminder snapshot", string(raw), err)
	}
}

func reminderPath(client string) string { return "clients/" + client + "/reminders" }
func reminderMutation(t *testing.T, w *httptest.ResponseRecorder, status int) reminders.Mutation {
	t.Helper()
	assertStatus(t, w, status, "")
	var e struct {
		Data reminders.Mutation `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil || e.Data.ID == "" {
		t.Fatal("missing reminder result", err)
	}
	return e.Data
}
func reminderBody(p reminders.Profile, revision int64) map[string]any {
	raw, _ := json.Marshal(p)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	body["expected_revision"] = revision
	return body
}
func TestReminderHTTPLifecycleDueViewsAndTerminalHistory(t *testing.T) {
	f := newReminderFixture(t)
	ctx := correlation.New(f.base.ctx)
	path := reminderPath(clientAID)
	for _, action := range []string{"complete", "dismiss"} {
		p := reminderProfile()
		p.ScheduledLocal = time.Now().Add(-time.Hour).UTC().Format("2006-01-02T15:04:05.999999")
		m := reminderMutation(t, f.request(t, &f.login, "POST", path, p, nil), 201)
		r, err := f.reminders.Detail(ctx, f.actor, clientAID, m.ID)
		if err != nil || !r.IsDue || r.CompletedAt != nil || r.DismissedAt != nil {
			t.Fatal("past reminder not pending/due", err)
		}
		p.OwnerID = f.actor
		p.Title = "Edited reminder"
		m = reminderMutation(t, f.request(t, &f.login, "PUT", path+"/"+m.ID, reminderBody(p, m.Revision), nil), 200)
		assertStatus(t, f.request(t, &f.login, "PUT", path+"/"+m.ID, reminderBody(p, 1), nil), 409, "conflict")
		if action == "dismiss" {
			assertStatus(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/dismiss", map[string]any{"expected_revision": m.Revision}, nil), 400, "invalid_request")
		}
		body := map[string]any{"expected_revision": m.Revision}
		if action == "dismiss" {
			body["confirm"] = true
		}
		before := time.Now().Add(-time.Second)
		m = reminderMutation(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/"+action, body, nil), 200)
		r, err = f.reminders.Detail(ctx, f.actor, clientAID, m.ID)
		marker := r.CompletedAt
		state := "completed"
		if action == "dismiss" {
			marker = r.DismissedAt
			state = "dismissed"
		}
		if err != nil || r.Status != state || r.IsDue || r.Revision != 3 || marker == nil || marker.Before(before) || marker.After(time.Now().Add(time.Second)) || r.Description != p.Description {
			t.Fatal("terminal history or server marker changed", r, err)
		}
		for _, again := range []string{"complete", "dismiss"} {
			body := map[string]any{"expected_revision": m.Revision}
			if again == "dismiss" {
				body["confirm"] = true
			}
			assertStatus(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/"+again, body, nil), 409, "conflict")
		}
		assertStatus(t, f.request(t, &f.login, "PUT", path+"/"+m.ID, reminderBody(p, m.Revision), nil), 409, "conflict")
		filter := reminderFilter()
		filter.Status = state
		page, err := f.reminders.List(ctx, f.actor, clientAID, filter)
		if err != nil || len(page.Data) != 1 || page.Data[0].ID != m.ID {
			t.Fatal("terminal list not real history", err)
		}
		var events string
		if err := f.admin.QueryRow(ctx, `SELECT string_agg(event_name,',' ORDER BY occurred_at) FROM app.audit_events WHERE resource_id=$1::uuid`, m.ID).Scan(&events); err != nil || events != "reminder.created,reminder.updated,reminder."+state {
			t.Fatal("rejected state changes emitted an event", events, err)
		}
	}
	future := reminderProfile()
	future.ScheduledLocal = time.Now().Add(time.Hour).UTC().Format("2006-01-02T15:04:05.999999")
	m := f.createReminder(t, future)
	filter := reminderFilter()
	filter.Due = "upcoming"
	page, err := f.reminders.List(ctx, f.actor, clientAID, filter)
	if err != nil || len(page.Data) != 1 || page.Data[0].ID != m.ID || page.Data[0].IsDue {
		t.Fatal("upcoming filter included terminal/due data", err)
	}
	filter.Due = "due"
	page, err = f.reminders.List(ctx, f.actor, clientAID, filter)
	if err != nil || len(page.Data) != 0 {
		t.Fatal("terminal reminders became due", err)
	}
}

func TestReminderExactScopeViewPlusWritesAndOwnerIsNotAuthority(t *testing.T) {
	f := newReminderFixture(t)
	ctx := correlation.New(f.base.ctx)
	for _, permissions := range [][]authorization.Permission{{}, {authorization.RemindersView}, {authorization.RemindersCreate}, {authorization.RemindersUpdate}, {authorization.RemindersView, authorization.RemindersCreate}, {authorization.RemindersView, authorization.RemindersUpdate}} {
		user, _ := f.grantPlanning(t, permissions)
		has := func(p authorization.Permission) bool {
			for _, v := range permissions {
				if p == v {
					return true
				}
			}
			return false
		}
		m := f.createReminder(t, reminderProfile())
		_, err := f.reminders.Detail(ctx, user, clientAID, m.ID)
		if has(authorization.RemindersView) {
			if err != nil {
				t.Fatal(err)
			}
		} else if !errors.Is(err, reminders.ErrMissing) {
			t.Fatal("view bypassed", err)
		}
		_, err = f.reminders.Create(ctx, user, clientAID, reminderProfile())
		allowed := has(authorization.RemindersView) && has(authorization.RemindersCreate)
		if allowed {
			if err != nil {
				t.Fatal(err)
			}
		} else if !errors.Is(err, reminders.ErrMissing) {
			t.Fatal("create bypassed view-plus-write", err)
		}
		_, err = f.reminders.Complete(ctx, user, clientAID, m.ID, 1)
		allowed = has(authorization.RemindersView) && has(authorization.RemindersUpdate)
		if allowed {
			if err != nil {
				t.Fatal(err)
			}
		} else if !errors.Is(err, reminders.ErrMissing) {
			t.Fatal("update bypassed view-plus-write", err)
		}
		if _, err := f.reminders.Detail(ctx, user, clientBID, m.ID); !errors.Is(err, reminders.ErrMissing) {
			t.Fatal("IDOR detail", err)
		}
		if _, err := f.reminders.Create(ctx, user, clientBID, reminderProfile()); !errors.Is(err, reminders.ErrMissing) {
			t.Fatal("wrong-client create", err)
		}
		if _, err := f.reminders.List(ctx, user, clientBID, reminderFilter()); !errors.Is(err, reminders.ErrMissing) {
			t.Fatal("wrong-client list", err)
		}
	}
	owner, assignment := f.grantPlanning(t, []authorization.Permission{authorization.RemindersView})
	p := reminderProfile()
	p.OwnerID = owner
	m := f.createReminder(t, p)
	if _, err := f.reminders.Complete(ctx, owner, clientAID, m.ID, 1); !errors.Is(err, reminders.ErrMissing) {
		t.Fatal("ownership granted update", err)
	}
	if err := f.authorizer.RevokeRole(ctx, f.actor, assignment); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reminders.Detail(ctx, owner, clientAID, m.ID); !errors.Is(err, reminders.ErrMissing) {
		t.Fatal("historical owner granted view", err)
	}
}

func TestReminderOwnersAreBoundedEligibleAndRetainedHistorically(t *testing.T) {
	f := newReminderFixture(t)
	ctx := correlation.New(f.base.ctx)
	owner, assignment := f.grantPlanning(t, []authorization.Permission{authorization.RemindersView})
	foreign := f.user(t, "foreign.reminder.owner@example.com")
	disabled := f.user(t, "disabled.reminder.owner@example.com")
	role, err := f.accounts.CreateRole(ctx, f.actor, "Foreign reminder owner", []authorization.Permission{authorization.RemindersView})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.authorizer.AssignRole(ctx, f.actor, foreign.ID, role.ID, authorization.Client, clientBID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.accounts.DisableUser(ctx, f.actor, disabled.ID, 1); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		page, err := f.reminders.Owners(ctx, f.actor, clientAID, cursor, 1)
		if err != nil || len(page.Data) > 1 {
			t.Fatal("owner page", err)
		}
		for _, v := range page.Data {
			if seen[v.ID] || v.DisplayName == "" {
				t.Fatal("owner page duplicate or missing name")
			}
			seen[v.ID] = true
		}
		if page.Page.NextCursor == nil {
			break
		}
		cursor = *page.Page.NextCursor
	}
	if !seen[owner] || !seen[f.actor] || seen[foreign.ID] || seen[disabled.ID] {
		t.Fatal("owner discovery leaked wrong scope/disabled users")
	}
	for _, id := range []string{foreign.ID, disabled.ID, fixtureID} {
		p := reminderProfile()
		p.OwnerID = id
		if _, err := f.reminders.Create(ctx, f.actor, clientAID, p); !errors.Is(err, reminders.ErrOwner) {
			t.Fatal("ineligible owner accepted", err)
		}
	}
	p := reminderProfile()
	p.OwnerID = owner
	m := f.createReminder(t, p)
	if err := f.authorizer.RevokeRole(ctx, f.actor, assignment); err != nil {
		t.Fatal(err)
	}
	if _, err := f.accounts.DisableUser(ctx, f.actor, owner, 1); err != nil {
		t.Fatal(err)
	}
	p.Title = "Retained historical owner"
	m, err = f.reminders.Update(ctx, f.actor, clientAID, m.ID, 1, p)
	if err != nil {
		t.Fatal("historical owner was invalidated", err)
	}
	r, err := f.reminders.Detail(ctx, f.actor, clientAID, m.ID)
	if err != nil || r.OwnerID != owner {
		t.Fatal("owner history lost", err)
	}
	filter := reminderFilter()
	filter.Owner = owner
	page, err := f.reminders.List(ctx, f.actor, clientAID, filter)
	if err != nil || len(page.Data) != 1 {
		t.Fatal("historical owner filter lost record", err)
	}
	p.OwnerID = f.actor
	m, err = f.reminders.Update(ctx, f.actor, clientAID, m.ID, m.Revision, p)
	if err != nil {
		t.Fatal(err)
	}
	p.OwnerID = owner
	if _, err := f.reminders.Update(ctx, f.actor, clientAID, m.ID, m.Revision, p); !errors.Is(err, reminders.ErrOwner) {
		t.Fatal("reassignment bypassed fresh eligibility", err)
	}
	viewer, _ := f.grantPlanning(t, []authorization.Permission{authorization.RemindersView})
	if _, err := f.reminders.Owners(ctx, viewer, clientAID, "", 25); !errors.Is(err, reminders.ErrMissing) {
		t.Fatal("read-only owner directory allowed", err)
	}
}

func TestReminderListsLiteralPagingOwnerAndArchivedClientHistory(t *testing.T) {
	f := newReminderFixture(t)
	ctx := correlation.New(f.base.ctx)
	var ids []string
	for i := 0; i < 5; i++ {
		p := reminderProfile()
		p.Title = fmt.Sprintf("Literal %% fixture %d", i)
		ids = append(ids, f.createReminder(t, p).ID)
	}
	sort.Strings(ids)
	for _, direction := range []string{"id", "-id"} {
		filter := reminderFilter()
		filter.Limit = 2
		filter.Search = "%"
		filter.Sort = direction
		filter.Owner = "me"
		var got []string
		for {
			page, err := f.reminders.List(ctx, f.actor, clientAID, filter)
			if err != nil || len(page.Data) > 2 {
				t.Fatal(err)
			}
			for _, r := range page.Data {
				got = append(got, r.ID)
			}
			if page.Page.NextCursor == nil {
				break
			}
			filter.Cursor = *page.Page.NextCursor
		}
		want := append([]string(nil), ids...)
		if direction == "-id" {
			sort.Sort(sort.Reverse(sort.StringSlice(want)))
		}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatal("bounded pages lost/duplicated rows")
		}
	}
	if _, err := f.records.Archive(ctx, f.actor, clientAID, 1); err != nil {
		t.Fatal(err)
	}
	page, err := f.reminders.List(ctx, f.actor, clientAID, reminderFilter())
	if err != nil || len(page.Data) != 5 {
		t.Fatal("client archive lost reminder history", err)
	}
	p := reminderProfile()
	p.OwnerID = f.actor
	if _, err := f.reminders.Update(ctx, f.actor, clientAID, ids[0], 1, p); !errors.Is(err, reminders.ErrConflict) {
		t.Fatal("archived client update allowed", err)
	}
	if _, err := f.reminders.Create(ctx, f.actor, clientAID, reminderProfile()); !errors.Is(err, reminders.ErrConflict) {
		t.Fatal("archived client create allowed", err)
	}
	if _, err := f.reminders.Complete(ctx, f.actor, clientAID, ids[0], 1); !errors.Is(err, reminders.ErrConflict) {
		t.Fatal("archived client completion allowed", err)
	}
	if _, err := f.reminders.Owners(ctx, f.actor, clientAID, "", 25); !errors.Is(err, reminders.ErrConflict) {
		t.Fatal("archived client owners allowed", err)
	}
}

func TestReminderLinksScopePrivacyAndHistoricalRetention(t *testing.T) {
	f := newReminderFixture(t)
	ctx := correlation.New(f.base.ctx)
	user, _ := f.grantPlanning(t, []authorization.Permission{authorization.RemindersView, authorization.RemindersCreate, authorization.RemindersUpdate})
	task, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
	if err != nil {
		t.Fatal(err)
	}
	foreignTask, err := f.tasks.Create(ctx, f.actor, clientBID, tasks.CreateInput{Profile: taskProfile()})
	if err != nil {
		t.Fatal(err)
	}
	plan := f.createPlan(t, "", planningProfile())
	child := f.createPlan(t, plan.ID, planningProfile())
	foreignPlan, err := f.plans.Create(ctx, f.actor, clientBID, "", planningProfile())
	if err != nil {
		t.Fatal(err)
	}
	foreignChild, err := f.plans.Create(ctx, f.actor, clientBID, foreignPlan.ID, planningProfile())
	if err != nil {
		t.Fatal(err)
	}
	// Even privileged storage writes cannot bypass the client/parent foreign keys.
	stored := f.createReminder(t, reminderProfile())
	for _, input := range []struct {
		sql string
		id  string
	}{
		{`UPDATE app.reminders SET task_id=$2::uuid WHERE id=$1::uuid`, foreignTask.ID},
		{`UPDATE app.reminders SET plan_id=$2::uuid WHERE id=$1::uuid`, foreignPlan.ID},
		{`UPDATE app.reminders SET milestone_id=$2::uuid,milestone_plan_id=$3::uuid WHERE id=$1::uuid`, foreignChild.ID},
		{`UPDATE app.reminders SET milestone_id=$2::uuid,milestone_plan_id=$3::uuid WHERE id=$1::uuid`, child.ID},
	} {
		args := []any{stored.ID, input.id}
		if strings.Contains(input.sql, "$3") {
			args = append(args, foreignPlan.ID)
		}
		if _, err := f.admin.Exec(ctx, input.sql, args...); err == nil {
			t.Fatal("storage accepted foreign-client or mismatched-parent reference")
		}
	}
	for _, link := range []reminders.Resource{{Kind: "task", ID: foreignTask.ID}, {Kind: "plan", ID: foreignPlan.ID}, {Kind: "milestone", ID: foreignChild.ID}, {Kind: "task", ID: plan.ID}, {Kind: "milestone", ID: fixtureID}} {
		p := reminderProfile()
		p.Resource = &link
		if _, err := f.reminders.Create(ctx, f.actor, clientAID, p); !errors.Is(err, reminders.ErrResource) {
			t.Fatal("foreign/missing resource link accepted", err)
		}
	}
	for _, link := range []reminders.Resource{{Kind: "task", ID: task.ID}, {Kind: "milestone", ID: child.ID}, {Kind: "plan", ID: plan.ID}} {
		p := reminderProfile()
		p.Resource = &link
		if _, err := f.reminders.Create(ctx, user, clientAID, p); !errors.Is(err, reminders.ErrResource) {
			t.Fatal("resource access inferred from reminder permissions", err)
		}
		m := f.createReminder(t, p)
		p.OwnerID = f.actor
		p.Title = "Retain authorized historical link"
		m, err = f.reminders.Update(ctx, user, clientAID, m.ID, 1, p)
		if err != nil {
			t.Fatal("historical link required current resource permission", err)
		}
		r, err := f.reminders.Detail(ctx, user, clientAID, m.ID)
		if err != nil || r.Resource == nil || *r.Resource != link {
			t.Fatal("link reference changed", err)
		}
		payload, _ := json.Marshal(r)
		if strings.Contains(string(payload), taskProfile().Title) || strings.Contains(string(payload), planningProfile().Title) || strings.Contains(string(payload), "milestone_plan_id") {
			t.Fatal("linked metadata leaked")
		}
		if link.Kind == "task" {
			if _, err := f.tasks.Archive(ctx, f.actor, clientAID, task.ID, 1); err != nil {
				t.Fatal(err)
			}
		}
		if link.Kind == "plan" {
			if _, err := f.plans.Archive(ctx, f.actor, clientAID, "", plan.ID, 1); err != nil {
				t.Fatal(err)
			}
		}
		if link.Kind == "milestone" {
			if _, err := f.admin.Exec(ctx, `UPDATE app.milestones SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, child.ID); err != nil {
				t.Fatal(err)
			}
		}
		m, err = f.reminders.Update(ctx, user, clientAID, m.ID, m.Revision, p)
		if err != nil {
			t.Fatal("archived historical link discarded", err)
		}
		p.Resource = nil
		m, err = f.reminders.Update(ctx, user, clientAID, m.ID, m.Revision, p)
		if err != nil {
			t.Fatal("explicit clearing required resource permission", err)
		}
		p.Resource = &link
		if _, err := f.reminders.Update(ctx, f.actor, clientAID, m.ID, m.Revision, p); !errors.Is(err, reminders.ErrResource) {
			t.Fatal("archived relinking accepted", err)
		}
	}
	var status string
	var revision int64
	if err := f.admin.QueryRow(ctx, `SELECT status,revision FROM app.tasks WHERE id=$1::uuid`, task.ID).Scan(&status, &revision); err != nil || status != "todo" || revision != 2 {
		t.Fatal("reminders rewrote task state/revision", err)
	}
}

func TestReminderAcceptsBothDSTFoldsAndRejectsGapsBeforeMutation(t *testing.T) {
	f := newReminderFixture(t)
	ctx := correlation.New(f.base.ctx)
	p := reminderProfile()
	p.ScheduledLocal = "2026-11-01T01:30:00.123456"
	p.Timezone = "America/New_York"
	for _, offset := range []int{-14400, -18000} {
		p.UTCOffsetSeconds = &offset
		m := f.createReminder(t, p)
		r, err := f.reminders.Detail(ctx, f.actor, clientAID, m.ID)
		expected := "2026-11-01T05:30:00.123456Z"
		if offset == -18000 {
			expected = "2026-11-01T06:30:00.123456Z"
		}
		if err != nil || r.ScheduledAt.Format(time.RFC3339Nano) != expected || r.ScheduledLocal != p.ScheduledLocal || r.UTCOffsetSeconds != offset || r.Timezone != p.Timezone {
			t.Fatal("DST occurrence was silently changed", err)
		}
	}
	var before int
	if err := f.admin.QueryRow(ctx, `SELECT count(*) FROM app.reminders`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	p.ScheduledLocal = "2026-03-08T02:30:00"
	for _, offset := range []int{-14400, -18000} {
		p.UTCOffsetSeconds = &offset
		if _, err := f.reminders.Create(ctx, f.actor, clientAID, p); !errors.Is(err, reminders.ErrSchedule) {
			t.Fatal("DST gap became a schedule", err)
		}
	}
	var after int
	if err := f.admin.QueryRow(ctx, `SELECT count(*) FROM app.reminders`).Scan(&after); err != nil || after != before {
		t.Fatal("rejected gap retained reminder", err)
	}
}
