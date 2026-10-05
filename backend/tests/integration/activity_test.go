//go:build integration

package integration

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/theroisey/else/backend/internal/activity"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/tasks"
)

type activityFixture struct {
	*reminderFixture
	activity *activity.Service
}

func newActivityFixture(t *testing.T) *activityFixture {
	t.Helper()
	f := newReminderFixture(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION app.activity_list(uuid,uuid,timestamptz,uuid,integer) TO `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	s, err := activity.NewService(f.runtime)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(f.logs, nil))
	auth, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	h, err := activity.NewHandler(s, auth, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = httpapi.RequestMiddleware(logger, h)
	return &activityFixture{f, s}
}
func activityPath(client string) string { return "clients/" + client + "/activity" }
func (f *activityFixture) list(t *testing.T, actor, client, cursor string, limit int) activity.Page {
	t.Helper()
	p, err := f.activity.List(f.base.ctx, actor, client, activity.Filter{Limit: limit, Cursor: cursor})
	if err != nil {
		t.Fatal("activity list failed", err)
	}
	return p
}
func (f *activityFixture) seedBusiness(t *testing.T) {
	t.Helper()
	ctx := correlation.New(f.base.ctx)
	if _, err := f.records.Update(ctx, f.actor, clientAID, 1, profileFixture()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()}); err != nil {
		t.Fatal(err)
	}
	plan := f.createPlan(t, "", planningProfile())
	f.createPlan(t, plan.ID, planningProfile())
	f.createReminder(t, reminderProfile())
}
func insertActivityEvent(ctx context.Context, q audit.Queries, client, event, kind, id string, stamp time.Time) error {
	_, err := q.Exec(ctx, `INSERT INTO app.audit_events(id,occurred_at,actor_kind,event_name,resource_kind,resource_id,client_id,request_id,before_state,after_state,metadata)
 VALUES($1::uuid,$2,'system',$3,$4,$1::uuid,$5::uuid,'AAAAAAAAAAAAAAAAAAAAAAAAAA','null','{"exists":true,"revision":1}','{"source":"cli"}')`, id, stamp, event, kind, client)
	return err
}
func TestActivityProjectsOnlyConfirmedBusinessEventsAndExactSafeFields(t *testing.T) {
	f := newActivityFixture(t)
	f.seedBusiness(t)
	ctx := correlation.New(f.base.ctx)
	p := f.list(t, f.actor, clientAID, "", 25)
	if len(p.Data) != 5 || p.Page.NextCursor != nil {
		t.Fatal("projection missing confirmed business events", p)
	}
	for _, e := range p.Data {
		if e.ClientID != clientAID || e.Summary == "" {
			t.Fatal("invalid projection", e)
		}
	}
	// Security, unknown actions/kinds, global history and other clients never join the projection.
	for i, e := range []struct{ client, kind, event string }{{clientAID, "role_assignment", "role_assignment.created"}, {clientAID, "user", "user.updated"}, {clientAID, "client", "client.deleted"}, {clientAID, "task", "task.deleted"}, {clientAID, "unknown", "unknown.created"}, {clientBID, "task", "task.created"}} {
		id := strings.Replace("90000000-0000-4000-8000-000000000000", "90000000", []string{"90000001", "90000002", "90000003", "90000004", "90000005", "90000006"}[i], 1)
		if err := insertActivityEvent(ctx, f.admin, e.client, e.event, e.kind, id, time.Now().UTC().Truncate(time.Microsecond)); err != nil {
			t.Fatal(err)
		}
	}
	var countBefore int
	if err := f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events`).Scan(&countBefore); err != nil {
		t.Fatal(err)
	}
	w := f.request(t, &f.login, "GET", activityPath(clientAID), nil, nil)
	assertStatus(t, w, 200, "")
	var raw struct {
		Data []map[string]json.RawMessage `json:"data"`
		Page map[string]json.RawMessage   `json:"page"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil || len(raw.Data) != 5 || len(raw.Page) != 2 {
		t.Fatal("response shape changed", err)
	}
	for _, row := range raw.Data {
		if len(row) != 7 {
			t.Fatal("activity expanded audit fields", row)
		}
		for _, key := range []string{"id", "client_id", "occurred_at", "event_type", "resource_kind", "resource_id", "summary"} {
			if _, ok := row[key]; !ok {
				t.Fatal("missing safe field", key)
			}
		}
	}
	for _, forbidden := range []string{"Synthetic private", "Synthetic Client", f.actor, "actor", "before_state", "after_state", "request_id", "metadata", "revision", "owner_id", "timezone", "scheduled", "password", f.login.Token, f.login.CSRF} {
		if strings.Contains(w.Body.String(), forbidden) {
			t.Fatal("private audit/profile field exposed", forbidden)
		}
	}
	var countAfter int
	if err := f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events`).Scan(&countAfter); err != nil || countBefore != countAfter {
		t.Fatal("read mutated audit history", err)
	}
}
func TestActivityLifecycleRetainsEarlierEventsAfterReopenAndResourceArchival(t *testing.T) {
	f := newActivityFixture(t)
	ctx := correlation.New(f.base.ctx)
	client, err := f.records.Create(ctx, f.actor, profileFixture())
	if err != nil {
		t.Fatal(err)
	}
	created := f.list(t, f.actor, client.ID, "", 25)
	if len(created.Data) != 2 || created.Data[0].Summary != "Website created." || created.Data[1].Summary != "Client created." {
		t.Fatal("confirmed client creation omitted", created)
	}
	if _, err := f.records.Update(ctx, f.actor, clientAID, 1, profileFixture()); err != nil {
		t.Fatal(err)
	}
	task, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
	if err != nil {
		t.Fatal(err)
	}
	changed := taskProfile()
	changed.Title = "Synthetic private revised task"
	task, err = f.tasks.Update(ctx, f.actor, clientAID, task.ID, task.Revision, changed)
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"in_progress", "done", "in_progress"} {
		task, err = f.tasks.Transition(ctx, f.actor, clientAID, task.ID, task.Revision, state)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.tasks.Archive(ctx, f.actor, clientAID, task.ID, task.Revision); err != nil {
		t.Fatal(err)
	}
	cancelled, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.tasks.Transition(ctx, f.actor, clientAID, cancelled.ID, 1, "cancelled"); err != nil {
		t.Fatal(err)
	}
	plan := f.createPlan(t, "", planningProfile())
	child := f.createPlan(t, plan.ID, planningProfile())
	if _, err := f.plans.Update(ctx, f.actor, clientAID, "", plan.ID, 1, planningProfile()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.plans.Update(ctx, f.actor, clientAID, plan.ID, child.ID, 1, planningProfile()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.plans.Archive(ctx, f.actor, clientAID, plan.ID, child.ID, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := f.plans.Archive(ctx, f.actor, clientAID, "", plan.ID, 2); err != nil {
		t.Fatal(err)
	}
	reminder := f.createReminder(t, reminderProfile())
	p := reminderProfile()
	p.OwnerID = f.actor
	p.Title = "Synthetic private revised reminder"
	if _, err := f.reminders.Update(ctx, f.actor, clientAID, reminder.ID, 1, p); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reminders.Complete(ctx, f.actor, clientAID, reminder.ID, 2); err != nil {
		t.Fatal(err)
	}
	dismissed := f.createReminder(t, reminderProfile())
	if _, err := f.reminders.Dismiss(ctx, f.actor, clientAID, dismissed.ID, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := f.records.Archive(ctx, f.actor, clientAID, 2); err != nil {
		t.Fatal(err)
	}
	page := f.list(t, f.actor, clientAID, "", 100)
	events := map[string]bool{"client.created": true}
	for _, e := range page.Data {
		events[e.EventType] = true
		if strings.Contains(e.Summary, "Synthetic") {
			t.Fatal("summary joined current private resource title")
		}
	}
	for _, event := range []string{"client.created", "client.updated", "client.archived", "task.created", "task.updated", "task.archived", "task.completed", "task.cancelled", "plan.created", "plan.updated", "plan.archived", "milestone.created", "milestone.updated", "milestone.archived", "reminder.created", "reminder.updated", "reminder.completed", "reminder.dismissed"} {
		if !events[event] {
			t.Fatal("confirmed lifecycle event was lost", event)
		}
	}
	if len(events) != 18 {
		t.Fatal("unreviewed lifecycle event appeared", events)
	}
}

func TestActivityRequiresClientAndActivityVisibilityThenIndependentDomainReads(t *testing.T) {
	f := newActivityFixture(t)
	f.seedBusiness(t)
	for _, test := range []struct {
		name        string
		permissions []authorization.Permission
		count       int
	}{
		{"no grants", nil, -1}, {"client only", []authorization.Permission{authorization.ClientsView}, -1}, {"activity only", []authorization.Permission{authorization.ActivityView}, -1},
		{"client activity", []authorization.Permission{authorization.ClientsView, authorization.ActivityView}, 1},
		{"task activity", []authorization.Permission{authorization.ClientsView, authorization.ActivityView, authorization.TasksView}, 2},
		{"planning activity", []authorization.Permission{authorization.ClientsView, authorization.ActivityView, authorization.PlanningView}, 3},
		{"reminder activity", []authorization.Permission{authorization.ClientsView, authorization.ActivityView, authorization.RemindersView}, 2},
		{"all business", []authorization.Permission{authorization.ClientsView, authorization.ActivityView, authorization.TasksView, authorization.PlanningView, authorization.RemindersView}, 5},
	} {
		t.Run(test.name, func(t *testing.T) {
			actor, _ := f.grantPlanning(t, test.permissions)
			p, err := f.activity.List(f.base.ctx, actor, clientAID, activity.Filter{Limit: 25})
			if test.count < 0 {
				if !errors.Is(err, activity.ErrMissing) {
					t.Fatal("activity bypassed root read capabilities", err)
				}
				return
			}
			if err != nil || len(p.Data) != test.count {
				t.Fatal("independent domain visibility not enforced", p, err)
			}
			if _, err := f.activity.List(f.base.ctx, actor, clientBID, activity.Filter{Limit: 25}); !errors.Is(err, activity.ErrMissing) {
				t.Fatal("client-scoped activity crossed client", err)
			}
			if _, err := f.runtime.Exec(f.base.ctx, `SELECT * FROM app.activity_list($1::uuid,$2::uuid,NULL,NULL,25)`, actor, clientBID); err == nil {
				t.Fatal("direct SQL reader bypassed client scope")
			}
		})
	}
	// Global grants work at both real clients but never fabricate a missing client.
	ctx := correlation.New(f.base.ctx)
	auditor := f.user(t, "activity.auditor@example.com")
	auditRole, err := f.accounts.CreateRole(ctx, f.actor, "Global audit reader", []authorization.Permission{authorization.AuditView})
	if err != nil {
		t.Fatal(err)
	}
	f.assignment(t, auditor.ID, auditRole.ID)
	if _, err := f.activity.List(ctx, auditor.ID, clientAID, activity.Filter{Limit: 25}); !errors.Is(err, activity.ErrMissing) {
		t.Fatal("audit.view granted client activity", err)
	}
	if p := f.list(t, f.actor, clientBID, "", 25); len(p.Data) != 0 || p.Data == nil {
		t.Fatal("empty authorized activity is not []", p)
	}
	for _, client := range []string{clientBID, "99999999-9999-4999-8999-999999999999"} {
		viewer, _ := f.grantPlanning(t, []authorization.Permission{authorization.ClientsView, authorization.ActivityView})
		if _, err := f.activity.List(f.base.ctx, viewer, client, activity.Filter{Limit: 25}); !errors.Is(err, activity.ErrMissing) {
			t.Fatal("missing/inaccessible client distinction", err)
		}
	}
}
func TestActivityChronologicalKeysetsPreserveEqualTimesAndBoundedPages(t *testing.T) {
	f := newActivityFixture(t)
	stamp := time.Date(2026, 10, 2, 12, 0, 0, 123456000, time.UTC)
	if _, err := f.admin.Exec(f.base.ctx, `INSERT INTO app.audit_events(id,occurred_at,actor_kind,event_name,resource_kind,resource_id,client_id,request_id,before_state,after_state,metadata)
 SELECT gen_random_uuid(),$1,'system','task.updated','task',gen_random_uuid(),$2::uuid,'AAAAAAAAAAAAAAAAAAAAAAAAAA','null','{"exists":true}','{"source":"job"}' FROM generate_series(1,105)`, stamp, clientAID); err != nil {
		t.Fatal(err)
	}
	first := f.list(t, f.actor, clientAID, "", 100)
	if len(first.Data) != 100 || first.Page.NextCursor == nil {
		t.Fatal("maximum page bound not enforced", first)
	}
	// A later commit above the boundary appears after refreshing the first page,
	// without duplication or moving the next page of equal-time events.
	newer := "ffffffff-ffff-4fff-8fff-ffffffffffff"
	if err := insertActivityEvent(f.base.ctx, f.admin, clientAID, "task.created", "task", newer, stamp.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	second := f.list(t, f.actor, clientAID, *first.Page.NextCursor, 100)
	if len(second.Data) != 5 || second.Page.NextCursor != nil {
		t.Fatal("page continuation skipped/repeated rows", second)
	}
	seen := map[string]bool{}
	last := ""
	for _, e := range append(first.Data, second.Data...) {
		if seen[e.ID] || !e.OccurredAt.Equal(stamp) || last != "" && last <= e.ID {
			t.Fatal("equal-time keyset order lost", e)
		}
		seen[e.ID] = true
		last = e.ID
	}
	if f.list(t, f.actor, clientAID, "", 25).Data[0].ID != newer {
		t.Fatal("refresh omitted new commit")
	}
	if _, err := f.activity.List(f.base.ctx, f.actor, clientBID, activity.Filter{Limit: 25, Cursor: *first.Page.NextCursor}); !errors.Is(err, activity.ErrInvalid) {
		t.Fatal("cursor accepted another client", err)
	}
	// Boundaries need not identify an existing event, preventing private-ID probes.
	cursor := base64.RawURLEncoding.EncodeToString([]byte("v1|" + clientAID + "|2026-10-02T11:00:00Z|11111111-1111-4111-8111-111111111111"))
	if p := f.list(t, f.actor, clientAID, cursor, 25); len(p.Data) != 0 {
		t.Fatal("cursor was interpreted as event lookup", p)
	}
}
func TestActivityRechecksRevocationDisablementAndArchivedClientHistory(t *testing.T) {
	f := newActivityFixture(t)
	f.seedBusiness(t)
	ctx := correlation.New(f.base.ctx)
	actor, assignment := f.grantPlanning(t, []authorization.Permission{authorization.ActivityView, authorization.ClientsView, authorization.TasksView})
	page := f.list(t, actor, clientAID, "", 1)
	if page.Data[0].ResourceKind != "task" || page.Page.NextCursor == nil {
		t.Fatal("expected task event before older client event", page)
	}
	var role string
	if err := f.admin.QueryRow(ctx, `SELECT role_id::text FROM app.user_roles WHERE id=$1::uuid`, assignment).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if _, err := f.accounts.ReplacePermissions(ctx, f.actor, role, 1, []authorization.Permission{authorization.ActivityView, authorization.ClientsView}); err != nil {
		t.Fatal(err)
	}
	p := f.list(t, actor, clientAID, *page.Page.NextCursor, 25)
	if len(p.Data) != 1 || p.Data[0].ResourceKind != "client" {
		t.Fatal("revoked domain blocked safe continuation or leaked history", p)
	}
	if _, err := f.records.Archive(ctx, f.actor, clientAID, 2); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, actor, clientAID, "", 25).Data) != 2 {
		t.Fatal("archival hid authorized client history")
	}
	if err := f.authorizer.RevokeRole(ctx, f.actor, assignment); err != nil {
		t.Fatal(err)
	}
	if _, err := f.activity.List(ctx, actor, clientAID, activity.Filter{Limit: 25}); !errors.Is(err, activity.ErrMissing) {
		t.Fatal("assignment revocation did not remove access", err)
	}
	// Global assignment remains possible for the archived client; disabled actors
	// lose SQL access and every existing HTTP session.
	disabled := f.user(t, "disabled.activity@example.com")
	roleRecord, err := f.accounts.CreateRole(ctx, f.actor, "Global activity reader", []authorization.Permission{authorization.ActivityView, authorization.ClientsView})
	if err != nil {
		t.Fatal(err)
	}
	f.assignment(t, disabled.ID, roleRecord.ID)
	login, err := f.service.Login(ctx, "disabled.activity@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &login, "GET", activityPath(clientAID), nil, nil), 200, "")
	if _, err := f.accounts.DisableUser(ctx, f.actor, disabled.ID, 1); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &login, "GET", activityPath(clientAID), nil, nil), 401, "authentication_required")
	if _, err := f.activity.List(ctx, disabled.ID, clientAID, activity.Filter{Limit: 25}); !errors.Is(err, activity.ErrMissing) {
		t.Fatal("disabled actor retained SQL access", err)
	}
}
func TestActivityObservesOnlyCommittedEventsAndAtomicBusinessRollback(t *testing.T) {
	f := newActivityFixture(t)
	ctx := correlation.New(f.base.ctx)
	tx, err := f.admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	id := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	if err := insertActivityEvent(ctx, tx, clientAID, "task.created", "task", id, time.Now().UTC().Truncate(time.Microsecond)); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, f.actor, clientAID, "", 25).Data) != 0 {
		t.Fatal("uncommitted event became activity")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, f.actor, clientAID, "", 25).Data) != 1 {
		t.Fatal("committed event did not become activity")
	}
	tx, err = f.admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := insertActivityEvent(ctx, tx, clientAID, "task.updated", "task", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", time.Now().UTC().Truncate(time.Microsecond)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, f.actor, clientAID, "", 25).Data) != 1 {
		t.Fatal("rolled-back event became activity")
	}
	if _, err := f.admin.Exec(ctx, `REVOKE INSERT ON app.audit_events FROM `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	if _, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()}); err == nil {
		t.Fatal("business write survived failed audit")
	}
	var tasksCount int
	if err := f.admin.QueryRow(ctx, `SELECT count(*) FROM app.tasks`).Scan(&tasksCount); err != nil || tasksCount != 0 || len(f.list(t, f.actor, clientAID, "", 25).Data) != 1 {
		t.Fatal("failed write appeared in activity", err)
	}
}
func TestActivityHTTPIsReadOnlyAuthenticatedAndRejectsHostileInputs(t *testing.T) {
	f := newActivityFixture(t)
	path := activityPath(clientAID)
	assertStatus(t, f.request(t, nil, "GET", path, nil, nil), 401, "authentication_required")
	assertStatus(t, f.request(t, &f.login, "GET", path, nil, func(r *http.Request) { r.Header.Del("Origin"); r.Header.Del("X-CSRF-Token") }), 200, "")
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
		w := f.request(t, &f.login, method, path, map[string]any{"event_type": "task.created"}, nil)
		assertStatus(t, w, 405, "method_not_allowed")
		if w.Header().Get("Allow") != "GET" {
			t.Fatal("read-only method list incorrect")
		}
	}
	head := f.request(t, &f.login, "HEAD", path, nil, nil)
	if head.Code != 405 || head.Header().Get("Allow") != "GET" || head.Body.Len() != 0 {
		t.Fatal("HEAD method/body semantics changed")
	}
	for _, query := range []string{"limit=0", "limit=101", "limit=1&limit=2", "cursor=bad", "offset=0", "q=secret", "event_type=task.created", "limit=", "cursor=", "before_state=x", "%zz=1"} {
		assertStatus(t, f.request(t, &f.login, "GET", path+"?"+query, nil, nil), 400, "invalid_request")
	}
	for _, bad := range []string{"clients/bad/activity", path + "/detail", path + "/"} {
		assertStatus(t, f.request(t, &f.login, "GET", bad, nil, nil), 400, "invalid_request")
	}
	reader, _ := f.grantPlanning(t, []authorization.Permission{authorization.ClientsView})
	var email string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT email FROM app.users WHERE id=$1::uuid`, reader).Scan(&email); err != nil {
		t.Fatal(err)
	}
	login, err := f.service.Login(correlation.New(f.base.ctx), email, bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	denied := f.request(t, &login, "GET", path, nil, nil)
	missing := f.request(t, &login, "GET", activityPath("99999999-9999-4999-8999-999999999999"), nil, nil)
	assertStatus(t, denied, 404, "not_found")
	assertStatus(t, missing, 404, "not_found")
	var a, b struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(denied.Body.Bytes(), &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(missing.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("missing and inaccessible activity responses differ")
	}
	if _, err := f.admin.Exec(f.base.ctx, `REVOKE EXECUTE ON FUNCTION app.activity_list(uuid,uuid,timestamptz,uuid,integer) FROM `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	w := f.request(t, &f.login, "GET", path, nil, nil)
	assertStatus(t, w, 500, "internal_error")
	if strings.Contains(w.Body.String(), "activity_list") || strings.Contains(f.logs.String(), "permission denied") {
		t.Fatal("database diagnostics leaked")
	}
}
func TestActivityRuntimeReaderDoesNotExpandAuditPrivileges(t *testing.T) {
	f := newActivityFixture(t)
	for _, query := range []string{"SELECT * FROM app.audit_events", "SELECT before_state,after_state FROM app.audit_events", "UPDATE app.audit_events SET event_name=event_name", "DELETE FROM app.audit_events", "TRUNCATE app.audit_events"} {
		if _, err := f.runtime.Exec(f.base.ctx, query); err == nil {
			t.Fatal("activity gained raw audit privileges", query)
		}
	}
	for _, args := range [][]any{{nil, nil, 0}, {nil, nil, 102}, {time.Now(), nil, 25}, {nil, fixtureID, 25}, {"infinity", fixtureID, 25}} {
		if _, err := f.runtime.Exec(f.base.ctx, `SELECT * FROM app.activity_list($1::uuid,$2::uuid,$3::timestamptz,$4::uuid,$5::integer)`, f.actor, clientAID, args[0], args[1], args[2]); err == nil {
			t.Fatal("SQL reader accepted unbounded/invalid boundary", args)
		}
	}
	bareRole, bareURL := f.base.role(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT USAGE ON SCHEMA app TO `+pgx.Identifier{bareRole}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(f.base.ctx, bareURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(f.base.ctx, `SELECT * FROM app.activity_list($1::uuid,$2::uuid,NULL,NULL,25)`, f.actor, clientAID); err == nil {
		t.Fatal("PUBLIC received activity EXECUTE")
	}
	var definer bool
	var volatility string
	var settings []string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT prosecdef,provolatile::text,proconfig FROM pg_proc WHERE oid='app.activity_list(uuid,uuid,timestamptz,uuid,integer)'::regprocedure`).Scan(&definer, &volatility, &settings); err != nil || !definer || volatility != "s" || len(settings) != 1 || settings[0] != "search_path=pg_catalog" {
		t.Fatal("unsafe definer reader settings", err)
	}
}
