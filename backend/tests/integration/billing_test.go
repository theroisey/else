//go:build integration

package integration

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/billing"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

const billingFunctions = `app.billing_read(uuid,uuid,uuid),app.billing_list(uuid,uuid,uuid,integer,text,text,text),app.billing_payments(uuid,uuid,uuid,uuid,integer),app.billing_summary(uuid,uuid),app.billing_currency_list(uuid,uuid),app.billing_write(uuid,uuid,uuid,bigint,text,jsonb,uuid)`

type billingFixture struct {
	*planningFixture
	billing *billing.Service
}

func newBillingFixture(t *testing.T) *billingFixture {
	t.Helper()
	f := newPlanningFixture(t)
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+billingFunctions+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	s, e := billing.NewService(f.runtime)
	if e != nil {
		t.Fatal(e)
	}
	logger := slog.New(slog.NewJSONHandler(f.logs, nil))
	auth, e := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if e != nil {
		t.Fatal(e)
	}
	h, e := billing.NewHandler(s, auth, logger)
	if e != nil {
		t.Fatal(e)
	}
	f.handler = httpapi.RequestMiddleware(logger, h)
	return &billingFixture{f, s}
}
func billingProfile() billing.Profile {
	return billing.Profile{Description: "Synthetic collection", InternalNote: "Synthetic private collection note", AmountMinor: "100", Currency: "USD"}
}
func billingPayment(command int, amount string) billing.PaymentInput {
	return billing.PaymentInput{CommandID: fmt.Sprintf("b1000000-0000-4000-8000-%012d", command), AmountMinor: amount, Currency: "USD", PaidOn: "2020-02-29", Method: "bank_transfer", Reference: "Synthetic private payment reference", Note: "Synthetic private payment note"}
}
func (f *billingFixture) createCollection(t *testing.T, p billing.Profile) billing.Mutation {
	t.Helper()
	m, e := f.billing.Create(correlation.New(f.base.ctx), f.actor, clientAID, p)
	if e != nil {
		t.Fatal(e)
	}
	return m
}
func (f *billingFixture) payment(t *testing.T, m billing.Mutation, p billing.PaymentInput) billing.Mutation {
	t.Helper()
	m, e := f.billing.RecordPayment(correlation.New(f.base.ctx), f.actor, clientAID, m.ID, m.Revision, p)
	if e != nil {
		t.Fatal(e)
	}
	return m
}
func (f *billingFixture) collection(t *testing.T, m billing.Mutation) billing.Collection {
	t.Helper()
	c, e := f.billing.Detail(f.base.ctx, f.actor, clientAID, m.ID)
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func (f *billingFixture) events(t *testing.T, id string) int {
	t.Helper()
	var n int
	if e := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid`, id).Scan(&n); e != nil {
		t.Fatal(e)
	}
	return n
}
func billingMutation(t *testing.T, w *httptest.ResponseRecorder, status int) billing.Mutation {
	t.Helper()
	assertStatus(t, w, status, "")
	var body struct {
		Data billing.Mutation `json:"data"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &body); e != nil || body.Data.ID == "" {
		t.Fatal("missing financial mutation", e)
	}
	return body.Data
}
func paymentBody(p billing.PaymentInput, revision string) map[string]any {
	raw, _ := json.Marshal(p)
	var b map[string]any
	_ = json.Unmarshal(raw, &b)
	b["expected_revision"] = revision
	return b
}
func profileBody(p billing.Profile, revision string) map[string]any {
	raw, _ := json.Marshal(p)
	var b map[string]any
	_ = json.Unmarshal(raw, &b)
	b["expected_revision"] = revision
	return b
}
func billingPath(client string) string { return "clients/" + client + "/billing" }

func TestBillingHTTPPartialSettlementReplayAndCancellationHistory(t *testing.T) {
	f := newBillingFixture(t)
	path := billingPath(clientAID)
	p := billingProfile()
	m := billingMutation(t, f.request(t, &f.login, "POST", path, p, nil), 201)
	if c := f.collection(t, m); c.Status != "pending" || c.PaidMinor != "0" || c.OutstandingMinor != "100" || c.Revision != "1" {
		t.Fatal(c)
	}
	p.Description = "Edited synthetic collection"
	p.AmountMinor = "120"
	m = billingMutation(t, f.request(t, &f.login, "PUT", path+"/"+m.ID, profileBody(p, m.Revision), nil), 200)
	command := billingPayment(1, "40")
	original := m.Revision
	m = billingMutation(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/payments", paymentBody(command, original), nil), 201)
	if c := f.collection(t, m); c.Status != "partially_paid" || c.PaidMinor != "40" || c.OutstandingMinor != "80" {
		t.Fatal(c)
	}
	replay := billingMutation(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/payments", paymentBody(command, original), nil), 200)
	if !replay.Replayed || replay.PaymentID == nil || m.PaymentID == nil || *replay.PaymentID != *m.PaymentID || replay.Revision != m.Revision || f.events(t, m.ID) != 3 {
		t.Fatal("retry changed ledger", replay)
	}
	for _, body := range []map[string]any{paymentBody(command, m.Revision), paymentBody(billingPayment(1, "41"), original)} {
		assertStatus(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/payments", body, nil), 409, "conflict")
	}
	p.AmountMinor = "121"
	assertStatus(t, f.request(t, &f.login, "PUT", path+"/"+m.ID, profileBody(p, m.Revision), nil), 409, "conflict")
	p.AmountMinor = "120"
	p.InternalNote = "Updated private note"
	m = billingMutation(t, f.request(t, &f.login, "PUT", path+"/"+m.ID, profileBody(p, m.Revision), nil), 200)
	assertStatus(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/cancel", map[string]any{"expected_revision": m.Revision}, nil), 400, "invalid_request")
	m = billingMutation(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/cancel", map[string]any{"expected_revision": m.Revision, "confirm": true}, nil), 200)
	if c := f.collection(t, m); c.Status != "cancelled" || c.PaidMinor != "40" || c.AmountMinor != "120" || c.OutstandingMinor != "0" || c.CancelledAt == nil {
		t.Fatal("cancellation discarded history", c)
	}
	assertStatus(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/payments", paymentBody(billingPayment(2, "1"), m.Revision), nil), 409, "conflict")
	assertStatus(t, f.request(t, &f.login, "PUT", path+"/"+m.ID, profileBody(p, m.Revision), nil), 409, "conflict")
	history, e := f.billing.Payments(f.base.ctx, f.actor, clientAID, m.ID, "", 25)
	if e != nil || len(history.Data) != 1 || history.Data[0].Reference != command.Reference || history.Data[0].Note != command.Note {
		t.Fatal("lost payment detail", e)
	}
	totals, e := f.billing.Summary(f.base.ctx, f.actor, clientAID)
	if e != nil || len(totals) != 1 || totals[0].AmountMinor != "0" || totals[0].OutstandingMinor != "0" || totals[0].CancelledAmountMinor != "120" || totals[0].CancelledPaidMinor != "40" {
		t.Fatal(totals, e)
	}
	if f.events(t, m.ID) != 5 {
		t.Fatal("rejected operations emitted audit")
	}
	var events string
	if e = f.admin.QueryRow(f.base.ctx, `SELECT string_agg(event_name,',' ORDER BY occurred_at) FROM app.audit_events WHERE resource_id=$1::uuid`, m.ID).Scan(&events); e != nil || events != "billing.created,billing.updated,billing.payment_recorded,billing.updated,billing.cancelled" {
		t.Fatal(events, e)
	}
	settled := f.createCollection(t, billingProfile())
	settled = f.payment(t, settled, billingPayment(3, "100"))
	if f.collection(t, settled).Status != "paid" {
		t.Fatal("not settled")
	}
	if _, e = f.billing.Cancel(correlation.New(f.base.ctx), f.actor, clientAID, settled.ID, settled.Revision); !errors.Is(e, billing.ErrConflict) {
		t.Fatal("cancelled settled collection", e)
	}
}

func TestBillingExactBoundsCurrencySummariesAndOverduePrecedence(t *testing.T) {
	f := newBillingFixture(t)
	ctx := correlation.New(f.base.ctx)
	if groups, e := f.billing.Summary(ctx, f.actor, clientAID); e != nil || len(groups) != 0 {
		t.Fatal("invented empty finance", e)
	}
	currencies, e := f.billing.Currencies(ctx, f.actor, clientAID)
	if e != nil || len(currencies) != 6 {
		t.Fatal(currencies, e)
	}
	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
	today := time.Now().UTC().Format("2006-01-02")
	for _, currency := range currencies {
		p := billingProfile()
		p.Currency = currency.Code
		p.AmountMinor = "9223372036854775807"
		m := f.createCollection(t, p)
		f.createCollection(t, p)
		if c := f.collection(t, m); c.CurrencyExponent != currency.Exponent || c.AmountMinor != p.AmountMinor {
			t.Fatal("currency scale changed", c)
		}
		pay := billingPayment(1, "9007199254740993")
		pay.Currency = currency.Code
		m = f.payment(t, m, pay)
		if c := f.collection(t, m); c.PaidMinor != pay.AmountMinor || c.OutstandingMinor != "9214364837600034814" {
			t.Fatal("money lost precision", c)
		}
		pay = billingPayment(2, "9214364837600034814")
		pay.Currency = currency.Code
		m = f.payment(t, m, pay)
		if c := f.collection(t, m); c.Status != "paid" || c.PaidMinor != p.AmountMinor {
			t.Fatal(c)
		}
	}
	totals, e := f.billing.Summary(ctx, f.actor, clientAID)
	if e != nil || len(totals) != 6 {
		t.Fatal(totals, e)
	}
	for _, group := range totals {
		if group.AmountMinor != "18446744073709551614" || group.PaidMinor != "9223372036854775807" || group.OutstandingMinor != "9223372036854775807" {
			t.Fatal("aggregate overflow or mixed currency", group)
		}
	}
	p := billingProfile()
	p.DueDate = &yesterday
	m := f.createCollection(t, p)
	if f.collection(t, m).Status != "overdue" {
		t.Fatal("past unpaid not overdue")
	}
	m = f.payment(t, m, billingPayment(3, "1"))
	if f.collection(t, m).Status != "overdue" {
		t.Fatal("partial payment hid overdue")
	}
	m = f.payment(t, m, billingPayment(4, "99"))
	if f.collection(t, m).Status != "paid" {
		t.Fatal("settlement failed precedence")
	}
	p.DueDate = &today
	m = f.createCollection(t, p)
	if f.collection(t, m).Status != "pending" {
		t.Fatal("today became overdue")
	}
}

func TestBillingExactScopeViewPlusGranularCommandsAndCurrentAccess(t *testing.T) {
	f := newBillingFixture(t)
	ctx := correlation.New(f.base.ctx)
	for mask := 0; mask < 16; mask++ {
		keys := []authorization.Permission{authorization.BillingView, authorization.BillingCreate, authorization.BillingUpdate, authorization.BillingDelete}
		grants := []authorization.Permission{}
		for i, k := range keys {
			if mask&(1<<i) != 0 {
				grants = append(grants, k)
			}
		}
		user, _ := f.grantPlanning(t, grants)
		m := f.createCollection(t, billingProfile())
		view := mask&1 != 0
		_, e := f.billing.Detail(ctx, user, clientAID, m.ID)
		if (e == nil) != view {
			t.Fatal(mask, "view", e)
		}
		_, e = f.billing.Create(ctx, user, clientAID, billingProfile())
		if (e == nil) != (view && mask&2 != 0) {
			t.Fatal(mask, "create", e)
		}
		_, e = f.billing.RecordPayment(ctx, user, clientAID, m.ID, m.Revision, billingPayment(1, "1"))
		if (e == nil) != (view && mask&4 != 0) {
			t.Fatal(mask, "payment", e)
		}
		m.Revision = f.collection(t, m).Revision
		_, e = f.billing.Cancel(ctx, user, clientAID, m.ID, m.Revision)
		if (e == nil) != (view && mask&8 != 0) {
			t.Fatal(mask, "cancel", e)
		}
		for _, read := range []func() error{func() error {
			_, e := f.billing.List(ctx, user, clientBID, billing.Filter{Limit: 25, Status: "all"})
			return e
		}, func() error { _, e := f.billing.Payments(ctx, user, clientBID, m.ID, "", 25); return e }, func() error { _, e := f.billing.Summary(ctx, user, clientBID); return e }, func() error { _, e := f.billing.Currencies(ctx, user, clientBID); return e }} {
			if !errors.Is(read(), billing.ErrMissing) {
				t.Fatal("wrong-client finance exposed")
			}
		}
	}
	legacy, _ := f.grantPlanning(t, []authorization.Permission{authorization.BillingView, authorization.BillingManage})
	if _, e := f.billing.Create(ctx, legacy, clientAID, billingProfile()); !errors.Is(e, billing.ErrMissing) {
		t.Fatal("legacy aggregate inferred new authority", e)
	}
	writer, assignment := f.grantPlanning(t, []authorization.Permission{authorization.BillingView, authorization.BillingCreate, authorization.BillingUpdate})
	m, e := f.billing.Create(ctx, writer, clientAID, billingProfile())
	if e != nil {
		t.Fatal(e)
	}
	if e = f.authorizer.RevokeRole(ctx, f.actor, assignment); e != nil {
		t.Fatal(e)
	}
	if _, e = f.billing.Detail(ctx, writer, clientAID, m.ID); !errors.Is(e, billing.ErrMissing) {
		t.Fatal("authorship retained view", e)
	}
}

func TestBillingCollectionAndPaymentPaginationAndStrictHTTPInputs(t *testing.T) {
	f := newBillingFixture(t)
	path := billingPath(clientAID)
	ctx := correlation.New(f.base.ctx)
	for i := 0; i < 27; i++ {
		p := billingProfile()
		p.Description = "Page synthetic " + strconv.Itoa(i)
		f.createCollection(t, p)
	}
	filter := billing.Filter{Limit: 25, Status: "all", Currency: "USD", Search: "Page synthetic"}
	first, e := f.billing.List(ctx, f.actor, clientAID, filter)
	if e != nil || len(first.Data) != 25 || first.Page.NextCursor == nil {
		t.Fatal(e)
	}
	filter.Cursor = *first.Page.NextCursor
	last, e := f.billing.List(ctx, f.actor, clientAID, filter)
	if e != nil || len(last.Data) != 2 || last.Page.NextCursor != nil {
		t.Fatal(e)
	}
	m := first.Data[0]
	mutation := billing.Mutation{ID: m.ID, Revision: m.Revision}
	for i := 1; i <= 27; i++ {
		mutation = f.payment(t, mutation, billingPayment(i, "1"))
	}
	payments, e := f.billing.Payments(ctx, f.actor, clientAID, m.ID, "", 25)
	if e != nil || len(payments.Data) != 25 || payments.Page.NextCursor == nil {
		t.Fatal(e)
	}
	tail, e := f.billing.Payments(ctx, f.actor, clientAID, m.ID, *payments.Page.NextCursor, 25)
	if e != nil || len(tail.Data) != 2 || tail.Page.NextCursor != nil {
		t.Fatal(e)
	}
	for _, query := range []string{"?limit=0", "?limit=101", "?limit=25&limit=25", "?currency=usd", "?cursor=bad", "?status=refunded", "?unknown=1", "?search=%00", "?limit="} {
		assertStatus(t, f.request(t, &f.login, "GET", path+query, nil, nil), 400, "invalid_request")
	}
	for _, body := range []any{map[string]any{"amount_minor": 1}, profileBody(billingProfile(), "1"), map[string]any{"description": "Synthetic", "currency": "USD", "amount_minor": "1.0"}} {
		assertStatus(t, f.request(t, &f.login, "POST", path, body, nil), 400, "invalid_request")
	}
	body := paymentBody(billingPayment(99, "1"), mutation.Revision)
	body["expected_revision"] = 28
	assertStatus(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/payments", body, nil), 400, "invalid_request")
	for _, verb := range []string{"DELETE", "PATCH", "OPTIONS"} {
		assertStatus(t, f.request(t, &f.login, verb, path+"/"+m.ID, nil, nil), 405, "method_not_allowed")
	}
	for _, action := range []string{"refund", "reverse"} {
		assertStatus(t, f.request(t, &f.login, "POST", path+"/"+m.ID+"/"+action, map[string]any{}, nil), 404, "not_found")
	}
	assertStatus(t, f.request(t, nil, "GET", path, nil, nil), 401, "authentication_required")
	assertStatus(t, f.request(t, &f.login, "POST", path, billingProfile(), func(r *http.Request) { r.Header.Set("Origin", "https://hostile.example") }), 403, "origin_forbidden")
	assertStatus(t, f.request(t, &f.login, "POST", path, billingProfile(), func(r *http.Request) { r.Header.Set("X-CSRF-Token", "invalid") }), 403, "csrf_failed")
	if strings.Contains(f.logs.String(), "Synthetic private") || strings.Contains(f.logs.String(), "disposable-test") {
		t.Fatal("unsafe finance logs")
	}
}
