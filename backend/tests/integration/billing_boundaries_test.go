//go:build integration

package integration

import (
	"encoding/json"
	"errors"
	"github.com/theroisey/else/backend/internal/auditreader"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/billing"
	"github.com/theroisey/else/backend/internal/correlation"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestBillingInvalidMoneyCurrencyDatesAndForbiddenCommandsNeverMutate(t *testing.T) {
	f := newBillingFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.createCollection(t, billingProfile())
	for _, amount := range []string{"0", "-1", "1.0", "1e2", "01", "9223372036854775808", "101"} {
		p := billingPayment(1, amount)
		if _, e := f.billing.RecordPayment(ctx, f.actor, clientAID, m.ID, m.Revision, p); e == nil {
			t.Fatal("invalid payment committed", amount)
		}
	}
	for _, mutate := range []func(*billing.PaymentInput){func(p *billing.PaymentInput) { p.Currency = "JPY" }, func(p *billing.PaymentInput) { p.Currency = "XXX" }, func(p *billing.PaymentInput) { p.PaidOn = "9999-12-31" }, func(p *billing.PaymentInput) { p.PaidOn = "2026-02-30" }, func(p *billing.PaymentInput) { p.Method = "refund" }, func(p *billing.PaymentInput) { p.CommandID = "00000000-0000-0000-0000-000000000000" }, func(p *billing.PaymentInput) { p.Reference = "private\x00secret" }} {
		p := billingPayment(1, "1")
		mutate(&p)
		if _, e := f.billing.RecordPayment(ctx, f.actor, clientAID, m.ID, m.Revision, p); e == nil {
			t.Fatal("invalid payment committed")
		}
	}
	p := billingProfile()
	p.Currency = "EUR"
	if _, e := f.billing.Update(ctx, f.actor, clientAID, m.ID, m.Revision, p); !errors.Is(e, billing.ErrConflict) {
		t.Fatal("currency changed", e)
	}
	for _, revision := range []string{"0", "01", "1.0", "9223372036854775807", "9223372036854775808"} {
		if _, e := f.billing.Cancel(ctx, f.actor, clientAID, m.ID, revision); !errors.Is(e, billing.ErrInvalid) {
			t.Fatal("invalid revision", e)
		}
	}
	path := billingPath(clientAID)
	for _, raw := range []string{`null`, `{"description":"Synthetic","currency":"USD","amount_minor":"1"} {}`, strings.Repeat("x", 65537)} {
		assertStatus(t, f.request(t, &f.login, "POST", path, nil, func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(raw)) }), 400, "invalid_request")
	}
	for _, field := range []string{"client_id", "created_by", "paid_minor", "status", "revision", "cancelled_at"} {
		body := profileBody(billingProfile(), "1")
		delete(body, "expected_revision")
		body[field] = f.actor
		assertStatus(t, f.request(t, &f.login, "POST", path, body, nil), 400, "invalid_request")
	}
	if c := f.collection(t, m); c.PaidMinor != "0" || c.Revision != "1" || f.events(t, m.ID) != 1 {
		t.Fatal("invalid writes mutated finance", c)
	}
	// Direct guarded calls repeat validation rather than trusting the Go adapter.
	for _, bad := range []string{"0", "-1", "1.0", "01", "9223372036854775808"} {
		profile := profileBody(billingProfile(), "1")
		delete(profile, "expected_revision")
		profile["amount_minor"] = bad
		raw, _ := json.Marshal(profile)
		var code string
		if e := f.runtime.QueryRow(ctx, `SELECT code FROM app.billing_write($1::uuid,$2::uuid,$3::uuid,0,'create',$4::jsonb,$5::uuid)`, f.actor, clientAID, fixtureID, raw, fixtureID).Scan(&code); e != nil || code != "invalid" {
			t.Fatal("SQL accepted invalid money", code, e)
		}
	}
}

func TestBillingAuditFailureRollsBackPaymentsBalancesAndAllCommands(t *testing.T) {
	f := newBillingFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.createCollection(t, billingProfile())
	m = f.payment(t, m, billingPayment(1, "1"))
	if _, e := f.admin.Exec(ctx, "REVOKE INSERT "+auditColumns+" ON app.audit_events FROM "+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	p := billingProfile()
	p.Description = "Uncommitted synthetic edit"
	for _, write := range []func() error{func() error { _, e := f.billing.Create(ctx, f.actor, clientAID, billingProfile()); return e }, func() error { _, e := f.billing.Update(ctx, f.actor, clientAID, m.ID, m.Revision, p); return e }, func() error {
		_, e := f.billing.RecordPayment(ctx, f.actor, clientAID, m.ID, m.Revision, billingPayment(2, "1"))
		return e
	}, func() error { _, e := f.billing.Cancel(ctx, f.actor, clientAID, m.ID, m.Revision); return e }} {
		if write() == nil {
			t.Fatal("unaudited write succeeded")
		}
	}
	assertStatus(t, f.request(t, &f.login, "POST", billingPath(clientAID)+"/"+m.ID+"/payments", paymentBody(billingPayment(2, "1"), m.Revision), nil), 500, "internal_error")
	if c := f.collection(t, m); c.Revision != "2" || c.PaidMinor != "1" || c.Description != billingProfile().Description || c.CancelledAt != nil {
		t.Fatal("audit failure changed balance", c)
	}
	var records, payments int
	if e := f.admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM app.collections),(SELECT count(*) FROM app.payments)`).Scan(&records, &payments); e != nil || records != 1 || payments != 1 || f.events(t, m.ID) != 2 {
		t.Fatal("audit failure retained ledger", e)
	}
	// Committed reconciliation does not require an audit INSERT and adds no event.
	replay, e := f.billing.RecordPayment(ctx, f.actor, clientAID, m.ID, "1", billingPayment(1, "1"))
	if e != nil || !replay.Replayed {
		t.Fatal("reconciliation tried to emit audit", e)
	}
	if strings.Contains(f.logs.String(), "Synthetic private") || strings.Contains(f.logs.String(), "permission denied") {
		t.Fatal("unsafe financial error logs")
	}
}

func TestBillingStorageDeniesRewritesAndEnforcesLedgerReferences(t *testing.T) {
	f := newBillingFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.createCollection(t, billingProfile())
	m = f.payment(t, m, billingPayment(1, "1"))
	for _, table := range []string{"collections", "payments", "billing_currencies"} {
		for _, sql := range []string{"SELECT * FROM app." + table, "DELETE FROM app." + table, "TRUNCATE app." + table} {
			if _, e := f.runtime.Exec(ctx, sql); e == nil {
				t.Fatal("runtime reached financial storage", sql)
			}
		}
	}
	for _, sql := range []string{`UPDATE app.payments SET reference='Synthetic rewrite'`, `DELETE FROM app.payments`, `TRUNCATE app.payments`, `DELETE FROM app.collections`, `TRUNCATE app.collections`, `UPDATE app.collections SET amount_minor=amount_minor+1`, `UPDATE app.collections SET currency='EUR'`, `UPDATE app.collections SET paid_minor=paid_minor+1`} {
		if _, e := f.admin.Exec(ctx, sql); e == nil {
			t.Fatal("financial history or ledger invariant bypassed", sql)
		}
	}
	for _, function := range []string{`app.billing_document($1::uuid)`, `app.billing_snapshot($1::uuid)`} {
		if _, e := f.runtime.Exec(ctx, "SELECT "+function, m.ID); e == nil {
			t.Fatal("runtime reached private financial projector")
		}
	}
	if _, e := f.admin.Exec(ctx, `DELETE FROM app.users WHERE id=$1::uuid`, f.actor); e == nil {
		t.Fatal("deleted historical actor")
	}
	var count int
	if e := f.admin.QueryRow(ctx, `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'billing_%' AND p.prosecdef AND p.proconfig<>ARRAY['search_path=pg_catalog']`).Scan(&count); e != nil || count != 0 {
		t.Fatal("unsafe financial definer", e)
	}
	if _, e := f.admin.Exec(ctx, `INSERT INTO app.payments(id,collection_id,client_id,currency,recorded_by,amount_minor,paid_on,method,command_id,expected_revision,collection_revision) VALUES($1::uuid,$2::uuid,$3::uuid,'EUR',$4::uuid,1,'2020-02-29','cash',$1::uuid,2,3)`, fixtureID, m.ID, clientAID, f.actor); e == nil {
		t.Fatal("mixed ledger currency accepted")
	}
	if _, e := f.admin.Exec(ctx, `INSERT INTO app.payments(id,collection_id,client_id,currency,recorded_by,amount_minor,paid_on,method,command_id,expected_revision,collection_revision) VALUES($1::uuid,$2::uuid,$3::uuid,'USD',$4::uuid,1,'2020-02-29','cash',$1::uuid,2,3)`, fixtureID, m.ID, clientAID, f.actor); e == nil {
		t.Fatal("unbalanced ledger insert committed")
	}
}

func TestBillingMonetaryAuditStorageDoesNotExpandAuditReads(t *testing.T) {
	f := newBillingFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.createCollection(t, billingProfile())
	m = f.payment(t, m, billingPayment(1, "1"))
	m, e := f.billing.Cancel(ctx, f.actor, clientAID, m.ID, m.Revision)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.admin.Exec(ctx, `GRANT EXECUTE ON FUNCTION `+auditReaderFunctions+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	reader, e := auditreader.NewService(f.runtime)
	if e != nil {
		t.Fatal(e)
	}
	for _, action := range []string{"billing.created", "billing.payment_recorded", "billing.cancelled"} {
		result, e := reader.List(ctx, f.actor, clientAID, auditreader.Filter{Limit: 25, EventType: action, ResourceID: m.ID})
		if e != nil || len(result.Data) != 1 {
			t.Fatal("billing audit action not readable", action, e)
		}
		event := result.Data[0]
		detail, e := reader.Detail(ctx, f.actor, clientAID, event.ID)
		if e != nil {
			t.Fatal(e)
		}
		raw, _ := json.Marshal(detail)
		for _, unsafe := range []string{"currency", "amount_minor", "paid_minor", "billing_status", "Synthetic", "reference", "command_id"} {
			if strings.Contains(string(raw), unsafe) {
				t.Fatal("financial storage widened audit DTO", unsafe)
			}
		}
		var stored []byte
		if e = f.admin.QueryRow(ctx, `SELECT after_state FROM app.audit_events WHERE id=$1::uuid`, event.ID).Scan(&stored); e != nil {
			t.Fatal(e)
		}
		var fields map[string]any
		if e = json.Unmarshal(stored, &fields); e != nil || len(fields) != 6 || fields["currency"] != "USD" || fields["amount_minor"] != "100" {
			t.Fatal("missing safe financial snapshot", e)
		}
		if strings.Contains(string(stored), "Synthetic") || strings.Contains(string(stored), "reference") {
			t.Fatal("payment text entered audit")
		}
	}
	for _, input := range []struct{ kind, action, payload string }{
		{"client", "updated", `{"billing_status":"pending","currency":"USD","amount_minor":"100","paid_minor":"0"}`},
		{"billing", "payment_recorded", `{"currency":"USD"}`},
		{"billing", "updated", `{"billing_status":"pending","currency":"USD","amount_minor":100,"paid_minor":"0"}`},
		{"billing", "updated", `{"billing_status":"pending","currency":"USD","amount_minor":"9223372036854775808","paid_minor":"0"}`},
		{"billing", "updated", `{"billing_status":"pending","currency":"USD","amount_minor":"1","paid_minor":"2"}`},
		{"billing", "refund", `null`},
	} {
		if _, e := f.runtime.Exec(ctx, `INSERT INTO app.audit_events `+auditColumns+` VALUES('user',$1::uuid,$2,$3,$4::uuid,$5::uuid,$6,'null',$7::jsonb,'{"source":"http"}')`, f.actor, input.kind+"."+input.action, input.kind, fixtureID, clientAID, correlation.ID(ctx), input.payload); e == nil {
			t.Fatal("unsafe financial audit accepted")
		}
	}
}

func TestBillingArchivedAndDisabledHistoryAndRetryBoundaries(t *testing.T) {
	f := newBillingFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.createCollection(t, billingProfile())
	m = f.payment(t, m, billingPayment(1, "1"))
	user, _ := f.grantPlanning(t, []authorization.Permission{authorization.BillingView})
	if _, e := f.admin.Exec(ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID); e != nil {
		t.Fatal(e)
	}
	if _, e := f.billing.Create(ctx, f.actor, clientAID, billingProfile()); !errors.Is(e, billing.ErrConflict) {
		t.Fatal(e)
	}
	if _, e := f.billing.RecordPayment(ctx, f.actor, clientAID, m.ID, m.Revision, billingPayment(2, "1")); !errors.Is(e, billing.ErrConflict) {
		t.Fatal(e)
	}
	replay, e := f.billing.RecordPayment(ctx, f.actor, clientAID, m.ID, "1", billingPayment(1, "1"))
	if e != nil || !replay.Replayed {
		t.Fatal("archival hid committed command", e)
	}
	if _, e := f.billing.Payments(ctx, f.actor, clientAID, m.ID, "", 25); e != nil {
		t.Fatal("archival hid history", e)
	}
	// Use a scoped actor so last-administrator protections are retained.
	if _, e = f.admin.Exec(ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, user); e != nil {
		t.Fatal(e)
	}
	if _, e = f.billing.Detail(ctx, user, clientAID, m.ID); !errors.Is(e, billing.ErrMissing) {
		t.Fatal("disabled user read financial history", e)
	}
}
