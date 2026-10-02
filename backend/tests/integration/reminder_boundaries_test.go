//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/reminders"
	"github.com/theroisey/else/backend/internal/tasks"
)

func TestReminderHTTPAuthenticationCSRFStrictInputAndPrivacy(t *testing.T) {
	f := newReminderFixture(t)
	path := reminderPath(clientAID)
	assertStatus(t, f.request(t, nil, "GET", path, nil, nil), 401, "authentication_required")
	for _, alter := range []func(*http.Request){func(r *http.Request) { r.Header.Del("X-CSRF-Token") }, func(r *http.Request) { r.Header.Set("Origin", "https://other.example") }, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }} {
		w := f.request(t, &f.login, "POST", path, reminderProfile(), alter)
		if w.Code != 403 && w.Code != 415 {
			t.Fatal("browser mutation boundary bypassed")
		}
	}
	for _, key := range []string{"created_by", "client_id", "scheduled_at", "status", "completed_at", "dismissed_at", "delivered_at"} {
		p := reminderBody(reminderProfile(), 1)
		delete(p, "expected_revision")
		p[key] = f.actor
		assertStatus(t, f.request(t, &f.login, "POST", path, p, nil), 400, "invalid_request")
	}
	for _, raw := range []string{`null`, `{"title":"valid"} {}`, strings.Repeat("x", 65537)} {
		assertStatus(t, f.request(t, &f.login, "POST", path, nil, func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(raw)) }), 400, "invalid_request")
	}
	p := reminderProfile()
	p.UTCOffsetSeconds = nil
	assertStatus(t, f.request(t, &f.login, "POST", path, p, nil), 400, "invalid_schedule")
	p = reminderProfile()
	p.Timezone = "Local"
	assertStatus(t, f.request(t, &f.login, "POST", path, p, nil), 400, "invalid_schedule")
	p = reminderProfile()
	p.Resource = &reminders.Resource{Kind: "task", ID: fixtureID}
	assertStatus(t, f.request(t, &f.login, "POST", path, p, nil), 400, "invalid_resource_link")
	m := reminderMutation(t, f.request(t, &f.login, "POST", path, reminderProfile(), nil), 201)
	for _, query := range []string{"limit=0", "limit=101", "limit=1&limit=2", "cursor=bad", "status=delivered", "due=notified", "owner=bad", "sort=title", "q=" + strings.Repeat("x", 101), "extra=1", "q="} {
		assertStatus(t, f.request(t, &f.login, "GET", path+"?"+query, nil, nil), 400, "invalid_request")
	}
	assertStatus(t, f.request(t, &f.login, "GET", path+"/owners?status=all", nil, nil), 400, "invalid_request")
	assertStatus(t, f.request(t, &f.login, "GET", path+"/"+m.ID+"?limit=1", nil, nil), 400, "invalid_request")
	assertStatus(t, f.request(t, &f.login, "GET", reminderPath(clientBID)+"/"+m.ID, nil, nil), 404, "not_found")
	assertStatus(t, f.request(t, &f.login, "DELETE", path+"/"+m.ID, nil, nil), 405, "method_not_allowed")
	assertStatus(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/complete", map[string]any{"expected_revision": 1, "completed_at": "2026-10-02T12:00:00Z"}, nil), 400, "invalid_request")
	var text string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT string_agg(before_state::text||after_state::text||metadata::text,'') FROM app.audit_events WHERE resource_kind='reminder'`).Scan(&text); err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{reminderProfile().Title, reminderProfile().Description, "owner_id", "scheduled_local", "utc_offset_seconds", "resource", "token", "password"} {
		if strings.Contains(text, private) || strings.Contains(f.logs.String(), private) {
			t.Fatal("private reminder metadata entered audit or logs")
		}
	}
}

func TestReminderRuntimePrivateStorageAndUncheckedHelpers(t *testing.T) {
	f := newReminderFixture(t)
	ctx := correlation.New(f.base.ctx)
	f.createReminder(t, reminderProfile())
	for _, sql := range []string{`SELECT * FROM app.reminders`, `UPDATE app.reminders SET status='completed'`, `DELETE FROM app.reminders`,
		`SELECT app.reminder_document('11111111-1111-4111-8111-111111111111',true)`,
		`SELECT app.reminder_snapshot('11111111-1111-4111-8111-111111111111')`,
		`SELECT app.reminder_schedule_consistent('2026-10-02T12:00:00','UTC',0,'2026-10-02T12:00:00Z')`,
		`SELECT app.reminder_schedule_valid('2026-10-02T12:00:00','UTC',0,'2026-10-02T12:00:00Z')`} {
		if _, err := f.runtime.Exec(ctx, sql); err == nil {
			t.Fatal("runtime obtained unchecked reminder access")
		}
	}
	// Direct guarded calls repeat wall-clock validation, not merely Go validation.
	profile := reminderBody(reminderProfile(), 1)
	delete(profile, "expected_revision")
	profile["owner_id"] = f.actor
	profile["scheduled_at"] = "2026-03-08T07:30:00Z"
	profile["scheduled_local"] = "2026-03-08T02:30:00"
	profile["timezone"] = "America/New_York"
	profile["utc_offset_seconds"] = -18000
	raw, _ := json.Marshal(profile)
	var code string
	if err := f.runtime.QueryRow(ctx, `SELECT code FROM app.reminder_write($1::uuid,$2::uuid,$3::uuid,0,'create',$4::jsonb)`, f.actor, clientAID, fixtureID, raw).Scan(&code); err != nil || code != "invalid_schedule" {
		t.Fatal("SQL writer accepted DST gap", code, err)
	}
	profile["scheduled_at"] = "2026-10-02T12:01:00Z"
	profile["scheduled_local"] = "2026-10-02T12:00:60"
	profile["timezone"] = "UTC"
	profile["utc_offset_seconds"] = 0
	raw, _ = json.Marshal(profile)
	if err := f.runtime.QueryRow(ctx, `SELECT code FROM app.reminder_write($1::uuid,$2::uuid,$3::uuid,0,'create',$4::jsonb)`, f.actor, clientAID, fixtureID, raw).Scan(&code); err != nil || code != "invalid_schedule" {
		t.Fatal("SQL normalized invalid wall clock", code, err)
	}
}

func TestReminderTerminalCommandsPreserveIntentWhenZoneRulesDisagree(t *testing.T) {
	f := newReminderFixture(t)
	ctx := correlation.New(f.base.ctx)
	p := reminderProfile()
	p.Timezone = "America/New_York"
	p.ScheduledLocal = "2026-11-01T01:30:00.123456"
	offset := -18000
	p.UTCOffsetSeconds = &offset
	complete := f.createReminder(t, p)
	dismiss := f.createReminder(t, p)
	// Simulate newer PostgreSQL rules rejecting the original offset. Recorded
	// instants remain valid storage, while metadata replacements require review.
	if _, err := f.admin.Exec(ctx, `CREATE OR REPLACE FUNCTION app.reminder_schedule_valid(local_time text,zone text,utc_offset integer,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS 'SELECT false'`); err != nil {
		t.Fatal(err)
	}
	p.OwnerID = f.actor
	if _, err := f.reminders.Update(ctx, f.actor, clientAID, complete.ID, 1, p); !errors.Is(err, reminders.ErrSchedule) {
		t.Fatal("zone-rule disagreement silently changed metadata", err)
	}
	if _, err := f.reminders.Complete(ctx, f.actor, clientAID, complete.ID, 1); err != nil {
		t.Fatal("completion reinterpreted original schedule", err)
	}
	if _, err := f.reminders.Dismiss(ctx, f.actor, clientAID, dismiss.ID, 1); err != nil {
		t.Fatal("dismissal reinterpreted original schedule", err)
	}
	for _, id := range []string{complete.ID, dismiss.ID} {
		r, err := f.reminders.Detail(ctx, f.actor, clientAID, id)
		if err != nil || r.ScheduledAt.Format(time.RFC3339Nano) != "2026-11-01T06:30:00.123456Z" || r.UTCOffsetSeconds != -18000 || r.ScheduledLocal != p.ScheduledLocal {
			t.Fatal("recorded intent changed", err)
		}
	}
}

func TestReminderAuditFailureRollsBackCreateMetadataAndTerminalCommands(t *testing.T) {
	f := newReminderFixture(t)
	ctx := correlation.New(f.base.ctx)
	p := reminderProfile()
	m := f.createReminder(t, p)
	task, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(ctx, "REVOKE INSERT "+auditColumns+" ON app.audit_events FROM "+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reminders.Create(ctx, f.actor, clientAID, reminderProfile()); err == nil {
		t.Fatal("unaudited create succeeded")
	}
	p.OwnerID = f.actor
	p.Title = "Uncommitted metadata"
	p.Resource = &reminders.Resource{Kind: "task", ID: task.ID}
	p.ScheduledLocal = "2026-11-01T01:30:00.123456"
	p.Timezone = "America/New_York"
	offset := -18000
	p.UTCOffsetSeconds = &offset
	if _, err := f.reminders.Update(ctx, f.actor, clientAID, m.ID, 1, p); err == nil {
		t.Fatal("unaudited metadata succeeded")
	}
	for _, operation := range []func(context.Context, string, string, string, int64) (reminders.Mutation, error){f.reminders.Complete, f.reminders.Dismiss} {
		if _, err := operation(ctx, f.actor, clientAID, m.ID, 1); err == nil {
			t.Fatal("unaudited terminal command succeeded")
		}
	}
	r, err := f.reminders.Detail(ctx, f.actor, clientAID, m.ID)
	if err != nil || r.Title != reminderProfile().Title || r.Timezone != "UTC" || r.Resource != nil || r.Status != "pending" || r.Revision != 1 || r.CompletedAt != nil || r.DismissedAt != nil {
		t.Fatal("audit failure retained changes", err)
	}
	var records, events int
	if err := f.admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM app.reminders),(SELECT count(*) FROM app.audit_events WHERE resource_kind='reminder')`).Scan(&records, &events); err != nil || records != 1 || events != 1 {
		t.Fatal("failed audit was not atomic", err)
	}
}

func TestReminderAuditDatabaseRejectsUnreviewedKindsStatesAndSchedulingFields(t *testing.T) {
	f := newReminderFixture(t)
	ctx := correlation.New(f.base.ctx)
	for _, input := range []struct{ kind, payload string }{{"client", `{"reminder_status":"pending"}`}, {"reminder", `{"reminder_status":"delivered"}`}, {"reminder", `{"reminder_status":null}`}, {"reminder", `{"reminder_status":1}`}, {"reminder", `{"reminder_status":"pending","title":"private"}`}, {"reminder", `{"reminder_scheduled_at":"2026-10-02T12:00:00Z"}`}, {"reminder", `{"reminder_timezone":"UTC"}`}, {"reminder", `{"reminder_scheduled_at":"2026-02-30T12:00:00Z","reminder_timezone":"UTC"}`}, {"reminder", `{"reminder_scheduled_at":"2026-10-02T12:00:00+01:00","reminder_timezone":"UTC"}`}, {"reminder", `{"reminder_scheduled_at":"2026-10-02T12:00:00Z","reminder_timezone":"Local"}`}, {"reminder", `{"reminder_scheduled_at":"2026-10-02T12:00:00Z","reminder_timezone":"Unknown/Zone"}`}} {
		if _, err := f.runtime.Exec(ctx, `INSERT INTO app.audit_events `+auditColumns+` VALUES('user',$1::uuid,$2,$3,$4::uuid,$5::uuid,$6,'null',$7::jsonb,'{"source":"http"}')`, f.actor, input.kind+".updated", input.kind, fixtureID, clientAID, correlation.ID(ctx), input.payload); err == nil {
			t.Fatal("unreviewed reminder audit accepted")
		}
	}
	state := "pending"
	instant := time.Date(2026, 10, 2, 12, 0, 0, 123456000, time.UTC)
	zone := "America/New_York"
	err := audit.WithTransaction(ctx, f.runtime, func(context.Context, audit.Queries) (audit.Event, error) {
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: f.actor}, Action: audit.Created, ResourceKind: "reminder", ResourceID: fixtureID, ClientID: clientAID, After: &audit.Snapshot{ReminderStatus: &state, ReminderScheduledAt: &instant, ReminderTimezone: &zone}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
	if err != nil {
		t.Fatal("typed scheduling audit rejected", err)
	}
	for _, action := range []string{"cancelled", "archived", "delivered"} {
		if _, err := f.runtime.Exec(ctx, `INSERT INTO app.audit_events `+auditColumns+` VALUES('user',$1::uuid,$2,'reminder',$3::uuid,$4::uuid,$5,'null','{}','{"source":"http"}')`, f.actor, "reminder."+action, fixtureID, clientAID, correlation.ID(ctx)); err == nil {
			t.Fatal("unsupported reminder event accepted")
		}
	}
	if _, err := f.reminders.Detail(ctx, f.actor, clientAID, fixtureID); !errors.Is(err, reminders.ErrMissing) {
		t.Fatal("audit-only history fabricated a reminder")
	}
}
