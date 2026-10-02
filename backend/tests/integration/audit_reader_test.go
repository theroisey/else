//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/theroisey/else/backend/internal/auditreader"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/tasks"
)

const auditReaderFunctions = `app.audit_reader_list(uuid,uuid,uuid,uuid,text,text,text,uuid,text,timestamptz,timestamptz,timestamptz,uuid,integer),app.audit_reader_detail(uuid,uuid,uuid)`

type auditReadFixture struct {
	*activityFixture
	reader *auditreader.Service
}

func newAuditReadFixture(t *testing.T) *auditReadFixture {
	t.Helper()
	f := newActivityFixture(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+auditReaderFunctions+` TO `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	s, err := auditreader.NewService(f.runtime)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(f.logs, nil))
	auth, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	h, err := auditreader.NewHandler(s, auth, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = httpapi.RequestMiddleware(logger, h)
	return &auditReadFixture{f, s}
}
func (f *auditReadFixture) list(t *testing.T, actor, scope string, filter auditreader.Filter) auditreader.Page {
	t.Helper()
	p, err := f.reader.List(f.base.ctx, actor, scope, filter)
	if err != nil {
		t.Fatal("audit list failed", err)
	}
	return p
}
func (f *auditReadFixture) readerRole(t *testing.T, email string, permissions []authorization.Permission) (string, string) {
	t.Helper()
	u := f.user(t, email)
	role, err := f.accounts.CreateRole(correlation.New(f.base.ctx), f.actor, "Synthetic audit reader", permissions)
	if err != nil {
		t.Fatal(err)
	}
	return u.ID, f.assignment(t, u.ID, role.ID)
}
func TestAuditReadSummaryAndDetailExposeOnlyReviewedFields(t *testing.T) {
	f := newAuditReadFixture(t)
	f.seedBusiness(t)
	p := f.list(t, f.actor, clientAID, auditreader.Filter{Limit: 25})
	if len(p.Data) != 5 || p.Page.NextCursor != nil {
		t.Fatal("real committed events omitted", p)
	}
	var before string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT md5(string_agg(row_to_json(e)::text,'' ORDER BY id)) FROM app.audit_events e`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	w := f.request(t, &f.login, "GET", "clients/"+clientAID+"/audit-logs", nil, nil)
	assertStatus(t, w, 200, "")
	var envelope struct {
		Data []map[string]json.RawMessage
		Page map[string]json.RawMessage
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil || len(envelope.Data) != 5 || len(envelope.Page) != 2 {
		t.Fatal("unexpected summary shape", err)
	}
	for _, row := range envelope.Data {
		if len(row) != 10 || row["request_id"] == nil || row["actor_user_id"] == nil || row["schema_version"] == nil {
			t.Fatal("summary contract changed", row)
		}
		if row["before_state"] != nil || row["metadata"] != nil {
			t.Fatal("summary exposed detail")
		}
	}
	sawReminder := false
	for _, e := range p.Data {
		w := f.request(t, &f.login, "GET", "audit-logs/"+e.ID, nil, nil)
		assertStatus(t, w, 200, "")
		var d struct{ Data map[string]json.RawMessage }
		if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil || len(d.Data) != 13 {
			t.Fatal("detail contract changed", err)
		}
		detail, err := f.reader.Detail(f.base.ctx, f.actor, clientAID, e.ID)
		if err != nil || detail.After == nil || detail.After.Revision == nil || detail.Metadata.Source != "http" {
			t.Fatal("safe detail missing", err)
		}
		if e.ResourceKind == "reminder" {
			sawReminder = true
			if detail.After.ReminderScheduledAt == nil || detail.After.ReminderScheduledAt.Nanosecond() != 123456000 || *detail.After.ReminderTimezone != "UTC" {
				t.Fatal("reviewed reminder intent missing")
			}
		}
		for _, secret := range []string{"Synthetic private", "Synthetic Client", "Synthetic reminder", "password", f.login.Token, f.login.CSRF, "title", "description", "contacts", "owner_id"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatal("private field escaped detail", secret)
			}
		}
	}
	if !sawReminder {
		t.Fatal("reminder snapshot not tested")
	}
	var after string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT md5(string_agg(row_to_json(e)::text,'' ORDER BY id)) FROM app.audit_events e`).Scan(&after); err != nil || before != after {
		t.Fatal("reads changed immutable audit history", err)
	}
}
func TestAuditReadGlobalClientPolicyAndNoImplicitPermissions(t *testing.T) {
	f := newAuditReadFixture(t)
	f.seedBusiness(t)
	onlyAudit, _ := f.readerRole(t, "audit.only@example.com", []authorization.Permission{authorization.AuditView})
	p := f.list(t, onlyAudit, "", auditreader.Filter{Limit: 100})
	if len(p.Data) == 0 {
		t.Fatal("global security history omitted")
	}
	for _, e := range p.Data {
		if e.ClientID != nil {
			t.Fatal("audit-only role enumerated client history")
		}
	}
	clientEvents := f.list(t, f.actor, clientAID, auditreader.Filter{Limit: 25})
	for _, scope := range []string{"", clientAID, clientBID} {
		if _, err := f.reader.Detail(f.base.ctx, onlyAudit, scope, clientEvents.Data[0].ID); !errors.Is(err, auditreader.ErrMissing) {
			t.Fatal("inaccessible client event distinguished", scope, err)
		}
	}
	if _, err := f.reader.List(f.base.ctx, onlyAudit, clientAID, auditreader.Filter{Limit: 25}); !errors.Is(err, auditreader.ErrMissing) {
		t.Fatal("client route ignored profile visibility")
	}
	if _, err := f.reader.List(f.base.ctx, onlyAudit, "", auditreader.Filter{Limit: 25, ClientID: clientAID}); !errors.Is(err, auditreader.ErrMissing) {
		t.Fatal("collection client filter bypassed scope")
	}
	// An audit-only global role plus an independent exact-client view is sufficient;
	// domain/activity grants do not determine the privileged audit projection.
	role, err := f.accounts.CreateRole(correlation.New(f.base.ctx), f.actor, "Synthetic profile visibility", []authorization.Permission{authorization.ClientsView})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.authorizer.AssignRole(correlation.New(f.base.ctx), f.actor, onlyAudit, role.ID, authorization.Client, clientAID); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, onlyAudit, clientAID, auditreader.Filter{Limit: 25}).Data) != 6 {
		t.Fatal("independent root privileges did not authorize audit")
	}
	if _, err := f.reader.List(f.base.ctx, onlyAudit, clientBID, auditreader.Filter{Limit: 25}); !errors.Is(err, auditreader.ErrMissing) {
		t.Fatal("foreign client visible")
	}
	scoped := f.user(t, "audit.scoped@example.com")
	mixed, err := f.accounts.CreateRole(correlation.New(f.base.ctx), f.actor, "Synthetic scoped audit role", []authorization.Permission{authorization.AuditView, authorization.ClientsView})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.authorizer.AssignRole(correlation.New(f.base.ctx), f.actor, scoped.ID, mixed.ID, authorization.Client, clientAID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reader.List(f.base.ctx, scoped.ID, "", auditreader.Filter{Limit: 25}); !errors.Is(err, auditreader.ErrDenied) {
		t.Fatal("scoped assignment expanded global-only audit capability")
	}
	if _, err := f.reader.List(f.base.ctx, scoped.ID, clientAID, auditreader.Filter{Limit: 25}); !errors.Is(err, auditreader.ErrMissing) {
		t.Fatal("scoped audit role gained client reader")
	}
	if _, err := f.reader.Detail(f.base.ctx, scoped.ID, "", clientEvents.Data[0].ID); !errors.Is(err, auditreader.ErrDenied) {
		t.Fatal("authorship/visibility replaced audit permission")
	}
	if _, err := f.reader.Detail(f.base.ctx, f.actor, clientBID, clientEvents.Data[0].ID); !errors.Is(err, auditreader.ErrMissing) {
		t.Fatal("cross-client detail visible")
	}
	if _, err := f.reader.Detail(f.base.ctx, f.actor, "", fixtureID); !errors.Is(err, auditreader.ErrMissing) {
		t.Fatal("missing event distinguished")
	}
	orphan := "f5000000-0000-4000-8000-000000000001"
	if err := insertActivityEvent(f.base.ctx, f.admin, fixtureID, "task.created", "task", orphan, time.Now().UTC().Truncate(time.Microsecond)); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, f.actor, "", auditreader.Filter{Limit: 25, ResourceID: orphan}).Data) != 0 {
		t.Fatal("scope without real client exposed historical identifiers")
	}
	if _, err := f.reader.Detail(f.base.ctx, f.actor, "", orphan); !errors.Is(err, auditreader.ErrMissing) {
		t.Fatal("orphan detail exposed")
	}
}
func TestAuditReadClientGrantRevocationFiltersOldCursorAndDetail(t *testing.T) {
	f := newAuditReadFixture(t)
	reader, _ := f.readerRole(t, "audit.client.revoke@example.com", []authorization.Permission{authorization.AuditView})
	role, err := f.accounts.CreateRole(correlation.New(f.base.ctx), f.actor, "Synthetic client audit visibility", []authorization.Permission{authorization.ClientsView})
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := f.authorizer.AssignRole(correlation.New(f.base.ctx), f.actor, reader, role.ID, authorization.Client, clientAID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.authorizer.AssignRole(correlation.New(f.base.ctx), f.actor, reader, role.ID, authorization.Client, clientBID); err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2026, 10, 2, 12, 0, 0, 123456000, time.UTC)
	for n := 1; n <= 27; n++ {
		client := clientAID
		when := stamp
		if n == 27 {
			client = clientBID
			when = stamp.Add(-time.Microsecond)
		}
		id := fmt.Sprintf("f3000000-0000-4000-8000-%012d", n)
		if err := insertActivityEvent(f.base.ctx, f.admin, client, "task.updated", "task", id, when); err != nil {
			t.Fatal(err)
		}
	}
	filter := auditreader.Filter{Limit: 25, EventType: "task.updated", ActorKind: "system"}
	first := f.list(t, reader, "", filter)
	if len(first.Data) != 25 || first.Page.NextCursor == nil {
		t.Fatal("cursor boundary not established")
	}
	if err := f.authorizer.RevokeRole(correlation.New(f.base.ctx), f.actor, assignment); err != nil {
		t.Fatal(err)
	}
	filter.Cursor = *first.Page.NextCursor
	page := f.list(t, reader, "", filter)
	if len(page.Data) != 1 || page.Data[0].ClientID == nil || *page.Data[0].ClientID != clientBID {
		t.Fatal("revoked client retained rows or invalidated safe cursor", page)
	}
	if _, err := f.reader.Detail(f.base.ctx, reader, "", first.Data[0].ID); !errors.Is(err, auditreader.ErrMissing) {
		t.Fatal("revoked client retained detail", err)
	}
	if _, err := f.reader.List(f.base.ctx, reader, clientAID, auditreader.Filter{Limit: 25}); !errors.Is(err, auditreader.ErrMissing) {
		t.Fatal("revoked client retained scoped collection")
	}
}

func TestAuditReadObservesCommitRollbackAndFailedBusinessAudit(t *testing.T) {
	f := newAuditReadFixture(t)
	tx, err := f.admin.Begin(f.base.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	id := "f4000000-0000-4000-8000-000000000001"
	if err := insertActivityEvent(f.base.ctx, tx, clientAID, "task.created", "task", id, time.Now().UTC().Truncate(time.Microsecond)); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, f.actor, clientAID, auditreader.Filter{Limit: 25}).Data) != 0 {
		t.Fatal("uncommitted audit visible")
	}
	if _, err := f.reader.Detail(f.base.ctx, f.actor, clientAID, id); !errors.Is(err, auditreader.ErrMissing) {
		t.Fatal("uncommitted detail visible")
	}
	if err := tx.Commit(f.base.ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reader.Detail(f.base.ctx, f.actor, clientAID, id); err != nil {
		t.Fatal("committed detail missing", err)
	}
	tx, err = f.admin.Begin(f.base.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err := insertActivityEvent(f.base.ctx, tx, clientAID, "task.updated", "task", "f4000000-0000-4000-8000-000000000002", time.Now().UTC().Truncate(time.Microsecond)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(f.base.ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(f.base.ctx, `REVOKE INSERT ON app.audit_events FROM `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	if _, err := f.tasks.Create(correlation.New(f.base.ctx), f.actor, clientAID, tasks.CreateInput{Profile: taskProfile()}); err == nil {
		t.Fatal("failed audit left successful business mutation")
	}
	if len(f.list(t, f.actor, clientAID, auditreader.Filter{Limit: 25}).Data) != 1 {
		t.Fatal("rollback appeared in audit projection")
	}
}

func TestAuditReadRevocationDisablementAndArchivedHistory(t *testing.T) {
	f := newAuditReadFixture(t)
	f.seedBusiness(t)
	user, assignment := f.readerRole(t, "audit.revoke@example.com", []authorization.Permission{authorization.AuditView, authorization.ClientsView})
	p := f.list(t, user, clientAID, auditreader.Filter{Limit: 25})
	if _, err := f.records.Archive(correlation.New(f.base.ctx), f.actor, clientAID, 2); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, user, clientAID, auditreader.Filter{Limit: 25}).Data) != 6 {
		t.Fatal("archival hid retained history")
	}
	if err := f.authorizer.RevokeRole(correlation.New(f.base.ctx), f.actor, assignment); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reader.Detail(f.base.ctx, user, "", p.Data[0].ID); !errors.Is(err, auditreader.ErrDenied) {
		t.Fatal("revoked audit assignment retained reads")
	}
	disabled, _ := f.readerRole(t, "audit.disabled@example.com", []authorization.Permission{authorization.AuditView, authorization.ClientsView})
	if _, err := f.accounts.DisableUser(correlation.New(f.base.ctx), f.actor, disabled, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reader.List(f.base.ctx, disabled, "", auditreader.Filter{Limit: 25}); !errors.Is(err, auditreader.ErrDenied) {
		t.Fatal("disabled reader retained permission")
	}
}
func TestAuditReadFiltersAndStableEqualTimePages(t *testing.T) {
	f := newAuditReadFixture(t)
	stamp := time.Date(2026, 10, 2, 12, 0, 0, 123456000, time.UTC)
	if _, err := f.admin.Exec(f.base.ctx, `INSERT INTO app.audit_events(id,occurred_at,actor_kind,event_name,resource_kind,resource_id,client_id,request_id,before_state,after_state,metadata)
 SELECT ('f0000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'system','task.updated','task',('f0000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$2::uuid,'AAAAAAAAAAAAAAAAAAAAAAAAAA','null','{"exists":true,"revision":9223372036854775807,"task_status":"todo"}','{"source":"cli"}' FROM generate_series(1,105) n`, stamp, clientAID); err != nil {
		t.Fatal(err)
	}
	filter := auditreader.Filter{Limit: 25, ActorKind: "system", EventType: "task.updated", ResourceKind: "task", RequestID: strings.Repeat("A", 26), From: &stamp}
	until := stamp.Add(time.Second)
	filter.To = &until
	seen := map[string]bool{}
	first := f.list(t, f.actor, clientAID, filter)
	p := first
	total := 0
	last := ""
	for {
		for _, e := range p.Data {
			if seen[e.ID] || last != "" && last <= e.ID || !e.OccurredAt.Equal(stamp) {
				t.Fatal("equal-time boundary lost/repeated event")
			}
			seen[e.ID] = true
			last = e.ID
			total++
		}
		if p.Page.NextCursor == nil {
			break
		}
		filter.Cursor = *p.Page.NextCursor
		p = f.list(t, f.actor, clientAID, filter)
	}
	if total != 105 {
		t.Fatal("pagination omitted events", total)
	}
	if len(f.list(t, f.actor, clientAID, auditreader.Filter{Limit: 25, EventType: "task.updated", To: &stamp}).Data) != 0 {
		t.Fatal("exclusive end boundary included equal timestamp")
	}
	d, err := f.reader.Detail(f.base.ctx, f.actor, clientAID, first.Data[0].ID)
	if err != nil || *d.After.Revision != "9223372036854775807" {
		t.Fatal("full int64 revision changed", err)
	}
	if len(f.list(t, f.actor, clientAID, auditreader.Filter{Limit: 25, ResourceID: first.Data[0].ResourceID}).Data) != 1 {
		t.Fatal("exact resource filter failed")
	}
	if len(f.list(t, f.actor, clientAID, auditreader.Filter{Limit: 25, ActorID: f.actor, EventType: "task.updated"}).Data) != 0 {
		t.Fatal("actor filter included system events")
	}
	changed := auditreader.Filter{Limit: 25, Cursor: *first.Page.NextCursor, ActorKind: "system", EventType: "task.created"}
	if _, err := f.reader.List(f.base.ctx, f.actor, clientAID, changed); !errors.Is(err, auditreader.ErrInvalid) {
		t.Fatal("cursor crossed filters")
	}
	if _, err := f.reader.List(f.base.ctx, f.actor, "", auditreader.Filter{Limit: 25, Cursor: *first.Page.NextCursor, ClientID: clientAID}); !errors.Is(err, auditreader.ErrInvalid) {
		t.Fatal("cursor crossed route")
	}
	// Above-boundary inserts are observed only after returning to the first page.
	if err := insertActivityEvent(f.base.ctx, f.admin, clientAID, "task.updated", "task", "f0000000-0000-4000-8000-000000000999", stamp.Add(time.Microsecond)); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, f.actor, clientAID, auditreader.Filter{Limit: 100, EventType: "task.updated"}).Data) != 100 {
		t.Fatal("upper page bound failed")
	}
	if fresh := f.list(t, f.actor, clientAID, auditreader.Filter{Limit: 25, EventType: "task.updated"}); fresh.Data[0].ID != "f0000000-0000-4000-8000-000000000999" {
		t.Fatal("first-page refresh omitted newer committed event")
	}
	after := auditreader.Filter{Limit: 25, Cursor: *first.Page.NextCursor, ActorKind: "system", EventType: "task.updated", ResourceKind: "task", RequestID: strings.Repeat("A", 26), From: &stamp, To: &until}
	if p := f.list(t, f.actor, clientAID, after); p.Data[0].ID == "f0000000-0000-4000-8000-000000000999" {
		t.Fatal("newer insert crossed cursor")
	}
}
func TestAuditReadHTTPIsGetOnlyBoundedAndSafe(t *testing.T) {
	f := newAuditReadFixture(t)
	f.seedBusiness(t)
	p := f.list(t, f.actor, clientAID, auditreader.Filter{Limit: 25})
	id := p.Data[0].ID
	reader := f.user(t, "audit.http.denied@example.com")
	login, err := f.service.Login(correlation.New(f.base.ctx), "audit.http.denied@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &login, "GET", "audit-logs", nil, nil), 403, "permission_denied")
	assertStatus(t, f.request(t, &login, "GET", "audit-logs/"+id, nil, nil), 403, "permission_denied")
	assertStatus(t, f.request(t, &login, "GET", "clients/"+clientAID+"/audit-logs/"+id, nil, nil), 404, "not_found")
	if _, err := f.reader.List(f.base.ctx, reader.ID, "", auditreader.Filter{Limit: 25}); !errors.Is(err, auditreader.ErrDenied) {
		t.Fatal("own login/creation conferred implicit audit access")
	}
	for _, path := range []string{"audit-logs", "audit-logs/" + id, "clients/" + clientAID + "/audit-logs", "clients/" + clientAID + "/audit-logs/" + id} {
		w := f.request(t, nil, "GET", path, nil, nil)
		assertStatus(t, w, 401, "authentication_required")
		for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
			w := f.request(t, &f.login, method, path, nil, nil)
			code := "method_not_allowed"
			if method == "HEAD" {
				code = ""
			}
			assertStatus(t, w, 405, code)
			if w.Header().Get("Allow") != "GET" || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("read method/cache contract changed")
			}
			if method == "HEAD" && w.Body.Len() != 0 {
				t.Fatal("HEAD emitted body")
			}
		}
	}
	for _, path := range []string{"audit-logs?limit=0", "audit-logs?limit=101", "audit-logs?limit=25&limit=25", "audit-logs?cursor=bad", "audit-logs?request_id=private", "audit-logs?actor_id=invalid", "audit-logs?from=2026-02-30T00:00:00Z", "audit-logs/" + id + "?limit=1", "clients/" + clientAID + "/audit-logs?client_id=" + clientBID} {
		assertStatus(t, f.request(t, &f.login, "GET", path, nil, nil), 400, "invalid_request")
	}
	f.logs.Reset()
	if _, err := f.admin.Exec(f.base.ctx, `REVOKE EXECUTE ON FUNCTION `+auditReaderFunctions+` FROM `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	w := f.request(t, &f.login, "GET", "audit-logs/"+id, nil, nil)
	assertStatus(t, w, 500, "internal_error")
	for _, secret := range []string{"SQLSTATE", "audit_reader_detail", id, f.login.Token, "password"} {
		if strings.Contains(w.Body.String()+f.logs.String(), secret) {
			t.Fatal("diagnostic escaped public response/logs", secret)
		}
	}
}
func TestAuditReadRuntimeAndPublicCannotReadOrChangeRawHistory(t *testing.T) {
	f := newAuditReadFixture(t)
	for _, q := range []string{"SELECT * FROM app.audit_events", "SELECT before_state,after_state FROM app.audit_events", "UPDATE app.audit_events SET event_name=event_name", "DELETE FROM app.audit_events", "TRUNCATE app.audit_events", "SELECT app.audit_reader_snapshot('{}')"} {
		if _, err := f.runtime.Exec(f.base.ctx, q); err == nil {
			t.Fatal("raw audit capability exposed", q)
		}
	}
	for _, n := range []int{0, 102} {
		if _, err := f.runtime.Exec(f.base.ctx, `SELECT * FROM app.audit_reader_list($1::uuid,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$2)`, f.actor, n); err == nil {
			t.Fatal("direct SQL page unbounded", n)
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
	if _, err := conn.Exec(f.base.ctx, `SELECT * FROM app.audit_reader_detail($1::uuid,NULL,$2::uuid)`, f.actor, fixtureID); err == nil {
		t.Fatal("PUBLIC received guarded reader EXECUTE")
	}
	var count int
	if err := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname IN ('audit_reader_list','audit_reader_detail') AND p.prosecdef AND p.provolatile='s' AND p.proconfig=ARRAY['search_path=pg_catalog']`).Scan(&count); err != nil || count != 2 {
		t.Fatal("unsafe definer settings", err)
	}
}
func TestAuditReaderMigrationPreservesPopulatedAuditBusinessAndPermissions(t *testing.T) {
	f := newAuditReadFixture(t)
	if _, err := provider(t, f.base).DownTo(f.base.ctx, 11); err != nil {
		t.Fatal(err)
	}
	f.seedBusiness(t)
	digest := func() string {
		var v string
		if err := f.admin.QueryRow(f.base.ctx, `SELECT md5((SELECT string_agg(row_to_json(e)::text,'' ORDER BY id) FROM app.audit_events e)||(SELECT string_agg(row_to_json(p)::text,'' ORDER BY id) FROM app.role_permissions p)||(SELECT string_agg(row_to_json(c)::text,'' ORDER BY id) FROM app.clients c))`).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	before := digest()
	p := provider(t, f.base)
	if _, err := p.DownTo(f.base.ctx, 10); err != nil {
		t.Fatal(err)
	}
	if digest() != before {
		t.Fatal("reader down changed retained history")
	}
	if _, err := p.UpTo(f.base.ctx, 11); err != nil {
		t.Fatal(err)
	}
	if digest() != before {
		t.Fatal("reader up changed retained history")
	}
	if _, err := f.reader.List(f.base.ctx, f.actor, clientAID, auditreader.Filter{Limit: 25}); err == nil {
		t.Fatal("recreation inherited runtime grant")
	}
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+auditReaderFunctions+` TO `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, f.actor, clientAID, auditreader.Filter{Limit: 25}).Data) != 5 {
		t.Fatal("recreated reader lost old events")
	}
	var index bool
	var keys int
	if err := f.admin.QueryRow(f.base.ctx, `SELECT to_regclass('app.audit_events_time') IS NOT NULL,(SELECT count(*) FROM app.permissions)`).Scan(&index, &keys); err != nil || !index || keys != 30 {
		t.Fatal("reader changed permission catalog/index", err)
	}
	// Future storage fields cannot silently expand the snapshot projector.
	var projected string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT app.audit_reader_snapshot('{"exists":true,"revision":1,"future_secret":"private"}')::text`).Scan(&projected); err != nil || strings.Contains(projected, "private") {
		t.Fatal("projection inherited new metadata", err)
	}
}
