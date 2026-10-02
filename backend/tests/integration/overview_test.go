//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/overview"
)

type overviewFixture struct {
	*pricingFixture
	overview *overview.Service
}

func newOverviewFixture(t *testing.T) *overviewFixture {
	t.Helper()
	f := newPricingFixture(t)
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION app.client_overview(uuid,uuid) TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	s, e := overview.NewService(f.runtime)
	if e != nil {
		t.Fatal(e)
	}
	logger := slog.New(slog.NewJSONHandler(f.logs, nil))
	a, e := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if e != nil {
		t.Fatal(e)
	}
	h, e := overview.NewHandler(s, a, logger)
	if e != nil {
		t.Fatal(e)
	}
	f.handler = httpapi.RequestMiddleware(logger, h)
	return &overviewFixture{f, s}
}
func (f *overviewFixture) read(t *testing.T, actor string) overview.Overview {
	t.Helper()
	v, e := f.overview.Read(f.base.ctx, actor, clientAID)
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func overviewPath(client string) string { return "clients/" + client + "/overview" }
func (f *overviewFixture) seedAttention(t *testing.T) {
	t.Helper()
	// Insert deliberately synthetic source rows through the isolated owner fixture.
	for _, sql := range []string{
		`INSERT INTO app.tasks(id,client_id,created_by,title,description,status,priority,due_at)
   SELECT ('e1000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,$1::uuid,$2::uuid,
   'Synthetic task '||i,'Synthetic private task description','todo','urgent',statement_timestamp()-INTERVAL '1 hour'
   FROM generate_series(1,12) i`,
		`INSERT INTO app.tasks(id,client_id,created_by,title,status,priority,due_at)
   SELECT gen_random_uuid(),$1::uuid,$2::uuid,'Synthetic future task '||i,'blocked','low',
   statement_timestamp()+i*INTERVAL '1 hour' FROM generate_series(1,12) i`,
		`INSERT INTO app.tasks(id,client_id,created_by,title,status,priority,due_at,created_at,updated_at,completed_at,archived_at)
   SELECT gen_random_uuid(),$1::uuid,$2::uuid,'Excluded task '||i,CASE WHEN i=1 THEN 'done' ELSE 'todo' END,'medium',
   CASE WHEN i=3 THEN NULL WHEN i=4 THEN statement_timestamp()+INTERVAL '8 days' ELSE statement_timestamp()-INTERVAL '2 hours' END,
   '2020-01-01','2020-01-01',CASE WHEN i=1 THEN TIMESTAMPTZ '2020-01-01' END,
   CASE WHEN i=2 THEN TIMESTAMPTZ '2020-01-01' END FROM generate_series(1,4) i`,
		`INSERT INTO app.reminders(id,client_id,created_by,owner_id,title,description,status,scheduled_at,scheduled_local,timezone,utc_offset_seconds)
   SELECT ('e2000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,$1::uuid,$2::uuid,$2::uuid,
   'Synthetic reminder '||i,'Synthetic private reminder description','pending',v,
   to_char(v AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),'UTC',0
   FROM generate_series(1,25) i CROSS JOIN LATERAL (SELECT statement_timestamp()+
    CASE WHEN i<=12 THEN INTERVAL '-1 hour' WHEN i=25 THEN INTERVAL '8 days' ELSE (i-12)*INTERVAL '1 hour' END v) z`,
	} {
		if _, e := f.admin.Exec(f.base.ctx, sql, clientAID, f.actor); e != nil {
			t.Fatal(e)
		}
	}
}

func TestOverviewExactFinanceReconcilesLedgerAndImmutablePricingCopies(t *testing.T) {
	f := newOverviewFixture(t)
	ctx := correlation.New(f.base.ctx)
	for _, currency := range []string{"USD", "USD", "EUR", "GBP", "TRY", "JPY", "KWD"} {
		p := billingProfile()
		p.Currency = currency
		p.AmountMinor = "100"
		if currency == "USD" {
			p.AmountMinor = "9223372036854775807"
			p.DueDate = stringPtr("2020-02-29")
		}
		f.createCollection(t, p)
	}
	cancelled := f.createCollection(t, billingProfile())
	cancelled = f.payment(t, cancelled, billingPayment(91, "25"))
	if _, e := f.billing.Cancel(ctx, f.actor, clientAID, cancelled.ID, cancelled.Revision); e != nil {
		t.Fatal(e)
	}
	m := f.createPricing(t, pricingProfile())
	copy, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, pricingCopy(93))
	if e != nil {
		t.Fatal(e)
	}
	p := pricingProfile()
	p.EffectiveFrom = today()
	p.Lines[0].UnitPriceMinor = "200"
	if _, e = f.pricing.Append(ctx, f.actor, clientAID, m.ID, m.Revision, p); e != nil {
		t.Fatal(e)
	}
	if _, e = f.billing.Create(ctx, f.actor, clientBID, billingProfile()); e != nil {
		t.Fatal(e)
	}
	var before, after int
	if e = f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events`).Scan(&before); e != nil {
		t.Fatal(e)
	}
	result := f.read(t, f.actor)
	totals, e := f.billing.Summary(ctx, f.actor, clientAID)
	if e != nil || result.Finance == nil || !reflect.DeepEqual(result.Finance.Currencies, totals) || len(totals) != 6 {
		t.Fatal("finance does not reconcile with source", e)
	}
	for _, v := range totals {
		if v.Currency == "USD" && (v.AmountMinor != "18446744073709551739" || v.CancelledAmountMinor != "100" || v.CancelledPaidMinor != "25") {
			t.Fatal("large or cancelled totals changed", v)
		}
	}
	c, e := f.billing.Detail(ctx, f.actor, clientAID, copy.ID)
	if e != nil || c.AmountMinor != "125" {
		t.Fatal("later pricing rewrote copied finance", e)
	}
	w := f.request(t, &f.login, "GET", overviewPath(clientAID), nil, nil)
	assertStatus(t, w, 200, "")
	if e = f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events`).Scan(&after); e != nil || before != after {
		t.Fatal("overview mutated history", e)
	}
	for _, secret := range []string{"Synthetic private", "Synthetic pricing note", "internal_note", "unit_cost_minor", "cost_minor", "contacts", "password", "reference", "owner_id", "before_state", "after_state"} {
		if strings.Contains(w.Body.String(), secret) || strings.Contains(f.logs.String(), secret) {
			t.Fatal("sensitive expansion", secret)
		}
	}
	if !strings.Contains(w.Body.String(), `"18446744073709551739"`) {
		t.Fatal("wide aggregate lost exact string")
	}
}

func TestOverviewBoundedDueQueuesUseDeadlineAndUUIDOrder(t *testing.T) {
	f := newOverviewFixture(t)
	f.seedAttention(t)
	v := f.read(t, f.actor)
	if v.Tasks == nil || v.Reminders == nil {
		t.Fatal("missing authorized queues")
	}
	for _, q := range []overview.Queue[overview.Task]{v.Tasks.Overdue, v.Tasks.DueSoon} {
		if len(q.Items) != 5 || !q.HasMore {
			t.Fatal("task queue not bounded", q)
		}
		for i, item := range q.Items {
			if i > 0 && (item.DueAt.Before(q.Items[i-1].DueAt) || item.DueAt.Equal(q.Items[i-1].DueAt) && item.ID <= q.Items[i-1].ID) {
				t.Fatal("task deadline order changed")
			}
		}
	}
	for i, item := range v.Tasks.Overdue.Items {
		if item.ID != fmt.Sprintf("e1000000-0000-4000-8000-%012d", i+1) {
			t.Fatal("equal-time task tie changed")
		}
	}
	for _, q := range []overview.Queue[overview.Reminder]{v.Reminders.Due, v.Reminders.Upcoming} {
		if len(q.Items) != 5 || !q.HasMore {
			t.Fatal("reminder queue not bounded", q)
		}
		for i, item := range q.Items {
			if item.Timezone != "UTC" || i > 0 && (item.ScheduledAt.Before(q.Items[i-1].ScheduledAt) || item.ScheduledAt.Equal(q.Items[i-1].ScheduledAt) && item.ID <= q.Items[i-1].ID) {
				t.Fatal("reminder schedule order changed")
			}
		}
	}
	if !v.HorizonEnd.Equal(v.AsOf.Add(168 * time.Hour)) {
		t.Fatal("horizon changed")
	}
	for _, item := range v.Tasks.Overdue.Items {
		if item.DueAt.After(v.AsOf) {
			t.Fatal("future task classified overdue")
		}
	}
	for _, item := range v.Tasks.DueSoon.Items {
		if !item.DueAt.After(v.AsOf) || item.DueAt.After(v.HorizonEnd) {
			t.Fatal("task horizon changed")
		}
	}
	for _, item := range v.Reminders.Upcoming.Items {
		if !item.ScheduledAt.After(v.AsOf) || item.ScheduledAt.After(v.HorizonEnd) {
			t.Fatal("reminder horizon changed")
		}
	}
}

func TestOverviewIndependentModuleGrantsOmitHiddenCountsAndRows(t *testing.T) {
	f := newOverviewFixture(t)
	f.seedAttention(t)
	f.createCollection(t, billingProfile())
	permissions := []authorization.Permission{authorization.BillingView, authorization.TasksView, authorization.RemindersView, authorization.ActivityView}
	for mask := 0; mask < 16; mask++ {
		keys := []authorization.Permission{authorization.ClientsView}
		for i, p := range permissions {
			if mask&(1<<i) != 0 {
				keys = append(keys, p)
			}
		}
		actor, _ := f.grantPlanning(t, keys)
		v := f.read(t, actor)
		if (v.Finance != nil) != (mask&1 != 0) || (v.Tasks != nil) != (mask&2 != 0) || (v.Reminders != nil) != (mask&4 != 0) || (v.Activity != nil) != (mask&8 != 0) {
			t.Fatal("module permission boundary changed", mask)
		}
		raw, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		var fields map[string]json.RawMessage
		if e = json.Unmarshal(raw, &fields); e != nil {
			t.Fatal(e)
		}
		for i, name := range []string{"finance", "tasks", "reminders", "activity"} {
			if _, ok := fields[name]; ok != (mask&(1<<i) != 0) {
				t.Fatal("hidden module presence leaked", mask, name)
			}
		}
		if _, e = f.overview.Read(f.base.ctx, actor, clientBID); !errors.Is(e, overview.ErrMissing) {
			t.Fatal("foreign client exposed", e)
		}
	}
	actor, _ := f.grantPlanning(t, permissions)
	if _, e := f.overview.Read(f.base.ctx, actor, clientAID); !errors.Is(e, overview.ErrMissing) {
		t.Fatal("client-profile grant bypassed", e)
	}
	if _, e := f.overview.Read(f.base.ctx, f.actor, "99999999-9999-4999-8999-999999999999"); !errors.Is(e, overview.ErrMissing) {
		t.Fatal("missing client exposed", e)
	}
}

func TestOverviewActivityPreservesSafeSourceModuleFilteringAndBounds(t *testing.T) {
	f := newOverviewFixture(t)
	ctx := correlation.New(f.base.ctx)
	stamp := time.Now().UTC().Truncate(time.Microsecond)
	for i := 1; i <= 9; i++ {
		id := fmt.Sprintf("e3000000-0000-4000-8000-%012d", i)
		if e := insertActivityEvent(ctx, f.admin, clientAID, "task.created", "task", id, stamp); e != nil {
			t.Fatal(e)
		}
	}
	for i, event := range []struct{ kind, event string }{{"client", "client.updated"}, {"reminder", "reminder.created"}, {"plan", "plan.created"}, {"billing", "billing.created"}, {"pricing", "pricing.created"}, {"user", "user.updated"}} {
		id := fmt.Sprintf("e4000000-0000-4000-8000-%012d", i)
		if e := insertActivityEvent(ctx, f.admin, clientAID, event.event, event.kind, id, stamp.Add(time.Minute)); e != nil {
			t.Fatal(e)
		}
	}
	actor, _ := f.grantPlanning(t, []authorization.Permission{authorization.ClientsView, authorization.ActivityView, authorization.TasksView})
	v := f.read(t, actor)
	if v.Activity == nil || len(v.Activity.Items) != 5 || !v.Activity.HasMore {
		t.Fatal("activity not bounded")
	}
	for _, item := range v.Activity.Items {
		if item.Summary == "" || item.ClientID != clientAID || item.ResourceKind != "client" && item.ResourceKind != "task" {
			t.Fatal("source-module history expanded", item)
		}
	}
	if v.Activity.Items[1].ID != "e3000000-0000-4000-8000-000000000009" {
		t.Fatal("newest equal-time event order changed")
	}
	actor, _ = f.grantPlanning(t, []authorization.Permission{authorization.ClientsView, authorization.ActivityView})
	v = f.read(t, actor)
	if len(v.Activity.Items) != 1 || v.Activity.HasMore {
		t.Fatal("hidden task count/history exposed")
	}
}

type overviewTrace struct{ calls atomic.Int32 }

func (q *overviewTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	q.calls.Add(1)
	return ctx
}
func (q *overviewTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}
func TestOverviewReadUsesOneAggregateStatementRegardlessOfModuleCount(t *testing.T) {
	f := newOverviewFixture(t)
	f.seedAttention(t)
	tracer := &overviewTrace{}
	c := f.runtime.Config()
	c.ConnConfig.Tracer = tracer
	p, e := pgxpool.NewWithConfig(f.base.ctx, c)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(p.Close)
	s, e := overview.NewService(p)
	if e != nil {
		t.Fatal(e)
	}
	for _, actor := range []string{f.actor, func() string {
		a, _ := f.grantPlanning(t, []authorization.Permission{authorization.ClientsView})
		return a
	}()} {
		before := tracer.calls.Load()
		if _, e = s.Read(f.base.ctx, actor, clientAID); e != nil {
			t.Fatal(e)
		}
		if tracer.calls.Load()-before != 1 {
			t.Fatal("overview performed module/row query fan-out")
		}
	}
}
