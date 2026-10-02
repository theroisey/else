//go:build integration

package integration

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/billing"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/pricing"
)

const pricingFunctions = `app.pricing_read(uuid,uuid,uuid,uuid),app.pricing_list(uuid,uuid,uuid,uuid,integer),app.pricing_preview(uuid,uuid,jsonb),app.pricing_write(uuid,uuid,uuid,uuid,bigint,jsonb),app.pricing_copy(uuid,uuid,uuid,uuid,bigint,jsonb,uuid),app.pricing_snapshot_read(uuid,uuid,uuid)`

type pricingFixture struct {
	*billingFixture
	pricing *pricing.Service
}

func newPricingFixture(t *testing.T) *pricingFixture {
	t.Helper()
	f := newBillingFixture(t)
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+pricingFunctions+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	s, e := pricing.NewService(f.runtime)
	if e != nil {
		t.Fatal(e)
	}
	logger := slog.New(slog.NewJSONHandler(f.logs, nil))
	a, e := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if e != nil {
		t.Fatal(e)
	}
	h, e := pricing.NewHandler(s, a, logger)
	if e != nil {
		t.Fatal(e)
	}
	f.handler = httpapi.RequestMiddleware(logger, h)
	return &pricingFixture{f, s}
}
func pricingProfile() pricing.Profile {
	return pricing.Profile{Title: "Synthetic agreement", Note: "Synthetic pricing note", Currency: "USD", EffectiveFrom: "2020-02-29", Lines: []pricing.LineInput{{Description: "Synthetic service", Kind: "recurring", Frequency: "monthly", QuantityMicros: "1500000", UnitPriceMinor: "101", DiscountBPS: "2500", TaxBPS: "1000", UnitCostMinor: stringPtr("7")}}}
}
func stringPtr(v string) *string { return &v }
func today() string              { return time.Now().UTC().Format("2006-01-02") }
func pricingCopy(command int) pricing.CopyInput {
	return pricing.CopyInput{CommandID: fmt.Sprintf("c1000000-0000-4000-8000-%012d", command), BillingDate: today(), InternalNote: "Synthetic collection note"}
}
func (f *pricingFixture) createPricing(t *testing.T, p pricing.Profile) pricing.Mutation {
	t.Helper()
	m, e := f.pricing.Create(correlation.New(f.base.ctx), f.actor, clientAID, p)
	if e != nil {
		t.Fatal(e)
	}
	return m
}
func pricingBody(v any, revision string) map[string]any {
	raw, _ := json.Marshal(v)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	body["expected_revision"] = revision
	return body
}

func TestPricingHTTPVersionsCopiesAndUnchangedBillingContract(t *testing.T) {
	f := newPricingFixture(t)
	ctx := correlation.New(f.base.ctx)
	path := "clients/" + clientAID + "/pricing"
	p := pricingProfile()
	w := f.request(t, &f.login, "POST", path, p, nil)
	assertStatus(t, w, 201, "")
	var response struct {
		Data pricing.Mutation `json:"data"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &response); e != nil {
		t.Fatal(e)
	}
	m := response.Data
	preview, e := f.pricing.Preview(ctx, f.actor, clientAID, p)
	goResult, ge := pricing.Calculate(p)
	if e != nil || ge != nil || !reflect.DeepEqual(preview, goResult) || preview.TotalMinor != "125" {
		t.Fatal("SQL/Go disagreement", preview, goResult, e)
	}
	w = f.request(t, &f.login, "GET", path+"/"+m.ID+"/versions/"+m.VersionID, nil, nil)
	assertStatus(t, w, 200, "")
	if !strings.Contains(w.Body.String(), "unit_cost_minor") {
		t.Fatal("manager lost cost projection")
	}
	copyPath := path + "/" + m.ID + "/versions/" + m.VersionID + "/collections"
	input := pricingCopy(1)
	w = f.request(t, &f.login, "POST", copyPath, pricingBody(input, m.Revision), nil)
	assertStatus(t, w, 201, "")
	var copied struct {
		Data pricing.CollectionMutation `json:"data"`
	}
	if e = json.Unmarshal(w.Body.Bytes(), &copied); e != nil {
		t.Fatal(e)
	}
	c := copied.Data
	w = f.request(t, &f.login, "POST", copyPath, pricingBody(input, m.Revision), nil)
	assertStatus(t, w, 200, "")
	if !strings.Contains(w.Body.String(), `"replayed":true`) {
		t.Fatal("HTTP replay absent")
	}
	snapshot, e := f.pricing.Snapshot(ctx, f.actor, clientAID, c.ID)
	if e != nil || snapshot.TotalMinor != "125" || len(snapshot.Lines) != 1 || snapshot.CostMinor != nil || snapshot.Lines[0].UnitCostMinor != nil {
		t.Fatal("invalid or private snapshot", snapshot, e)
	}
	collection, e := f.billing.Detail(ctx, f.actor, clientAID, c.ID)
	if e != nil || collection.AmountMinor != "125" || collection.Description != p.Title || collection.Currency != "USD" {
		t.Fatal("billing copy wrong", collection, e)
	}
	changed := billing.Profile{Description: "Synthetic metadata edit", InternalNote: "", Currency: "USD", AmountMinor: "126"}
	if _, e = f.billing.Update(ctx, f.actor, clientAID, c.ID, c.Revision, changed); !errors.Is(e, billing.ErrConflict) {
		t.Fatal("copied obligation changed before payment", e)
	}
	changed.AmountMinor = "125"
	updated, e := f.billing.Update(ctx, f.actor, clientAID, c.ID, c.Revision, changed)
	if e != nil {
		t.Fatal("metadata edit prevented", e)
	}
	paid, e := f.billing.RecordPayment(ctx, f.actor, clientAID, c.ID, updated.Revision, billingPayment(1, "25"))
	if e != nil {
		t.Fatal("payment compatibility", e)
	}
	if _, e = f.billing.Cancel(ctx, f.actor, clientAID, c.ID, paid.Revision); e != nil {
		t.Fatal(e)
	}
	p.Title = "Synthetic later agreement"
	p.EffectiveFrom = today()
	p.Lines[0].UnitPriceMinor = "200"
	next, e := f.pricing.Append(ctx, f.actor, clientAID, m.ID, m.Revision, p)
	if e != nil || next.Revision != "2" {
		t.Fatal(e)
	}
	retained, e := f.pricing.Snapshot(ctx, f.actor, clientAID, c.ID)
	if e != nil || !reflect.DeepEqual(snapshot, retained) {
		t.Fatal("later pricing changed collection snapshot", e)
	}
	old, e := f.pricing.Version(ctx, f.actor, clientAID, m.ID, m.VersionID)
	if e != nil || old.Title != "Synthetic agreement" || old.TotalMinor != "125" || old.WindowUntil == nil || *old.WindowUntil != today() {
		t.Fatal("lost history or cap", old, e)
	}
	retry, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, input)
	if e != nil || !retry.Replayed || retry.ID != c.ID || retry.Revision != "4" || f.events(t, c.ID) != 4 {
		t.Fatal("replay changed history", retry, e)
	}
	if f.events(t, m.ID) != 2 {
		t.Fatal("pricing event missing")
	}
	var unsafe int
	if e = f.admin.QueryRow(ctx, `SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid AND (CASE WHEN before_state='null'::jsonb THEN false ELSE before_state-'exists'-'revision'<>'{}'::jsonb END OR after_state-'exists'-'revision'<>'{}'::jsonb)`, m.ID).Scan(&unsafe); e != nil || unsafe != 0 {
		t.Fatal("pricing audit leaked profile", e)
	}
	w = f.request(t, &f.login, "GET", "clients/"+clientAID+"/billing/"+c.ID+"/pricing-snapshot", nil, nil)
	assertStatus(t, w, 200, "")
	if strings.Contains(w.Body.String(), "cost") || strings.Contains(w.Body.String(), p.Note) {
		t.Fatal("snapshot leaks private pricing")
	}
}

func TestPricingEffectiveWindowsSameDayGapsAndFuture(t *testing.T) {
	f := newPricingFixture(t)
	ctx := correlation.New(f.base.ctx)
	p := pricingProfile()
	p.EffectiveUntil = stringPtr("2021-01-01")
	m := f.createPricing(t, p)
	gap := pricingCopy(1)
	gap.BillingDate = "2021-01-01"
	if _, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, gap); !errors.Is(e, pricing.ErrConflict) {
		t.Fatal("exclusive end accepted", e)
	}
	for _, day := range []string{"2019-01-01", "2021-01-01"} {
		p.EffectiveFrom = day
		p.EffectiveUntil = nil
		if _, e := f.pricing.Append(ctx, f.actor, clientAID, m.ID, m.Revision, p); !errors.Is(e, pricing.ErrConflict) {
			t.Fatal("retroactive version accepted", day, e)
		}
	}
	p.EffectiveFrom = today()
	p.EffectiveUntil = nil
	first, e := f.pricing.Append(ctx, f.actor, clientAID, m.ID, m.Revision, p)
	if e != nil {
		t.Fatal(e)
	}
	p.Title = "Same-day replacement"
	second, e := f.pricing.Append(ctx, f.actor, clientAID, m.ID, first.Revision, p)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.pricing.Copy(ctx, f.actor, clientAID, m.ID, first.VersionID, second.Revision, pricingCopy(2)); !errors.Is(e, pricing.ErrConflict) {
		t.Fatal("superseded same-day version copied", e)
	}
	if _, e = f.pricing.Copy(ctx, f.actor, clientAID, m.ID, second.VersionID, second.Revision, pricingCopy(3)); e != nil {
		t.Fatal("latest same-day not active", e)
	}
	p.EffectiveFrom = time.Now().UTC().AddDate(0, 0, 2).Format("2006-01-02")
	future, e := f.pricing.Append(ctx, f.actor, clientAID, m.ID, second.Revision, p)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.pricing.Copy(ctx, f.actor, clientAID, m.ID, future.VersionID, future.Revision, pricingCopy(4)); !errors.Is(e, pricing.ErrConflict) {
		t.Fatal("future version copied today", e)
	}
	if _, e = f.pricing.Copy(ctx, f.actor, clientAID, m.ID, second.VersionID, future.Revision, pricingCopy(5)); e != nil {
		t.Fatal("future version displaced current early", e)
	}
	input := pricingCopy(6)
	input.BillingDate = p.EffectiveFrom
	if _, e = f.pricing.Copy(ctx, f.actor, clientAID, m.ID, future.VersionID, future.Revision, input); !errors.Is(e, pricing.ErrInvalid) {
		t.Fatal("future billing date accepted", e)
	}
	p.Currency = "JPY"
	if _, e = f.pricing.Append(ctx, f.actor, clientAID, m.ID, future.Revision, p); !errors.Is(e, pricing.ErrConflict) {
		t.Fatal("sheet currency changed", e)
	}
	page, e := f.pricing.Versions(ctx, f.actor, clientAID, m.ID, "", 2)
	if e != nil || len(page.Data) != 2 || page.Page.NextCursor == nil {
		t.Fatal("unbounded version history", e)
	}
	rest, e := f.pricing.Versions(ctx, f.actor, clientAID, m.ID, *page.Page.NextCursor, 2)
	if e != nil || len(rest.Data) != 2 || rest.Page.NextCursor != nil || page.Data[1].ID >= rest.Data[0].ID {
		t.Fatal("version cursor wrong", e)
	}
}

func TestPricingClientPermissionsCostOmissionAndBillingOnlySnapshot(t *testing.T) {
	f := newPricingFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.createPricing(t, pricingProfile())
	copy, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, pricingCopy(1))
	if e != nil {
		t.Fatal(e)
	}
	for _, keys := range [][]authorization.Permission{{authorization.PricingView}, {authorization.PricingManage}, {authorization.PricingView, authorization.PricingManage}, {authorization.BillingView}, {authorization.PricingView, authorization.BillingView}, {authorization.PricingView, authorization.BillingCreate}, {authorization.PricingView, authorization.BillingView, authorization.BillingCreate}} {
		actor, assignment := f.grantPlanning(t, keys)
		view, manage, bview, bcreate := false, false, false, false
		for _, key := range keys {
			view = view || key == authorization.PricingView
			manage = manage || key == authorization.PricingManage
			bview = bview || key == authorization.BillingView
			bcreate = bcreate || key == authorization.BillingCreate
		}
		detail, e := f.pricing.Detail(ctx, actor, clientAID, m.ID)
		if view {
			if e != nil || (detail.LatestVersion.CostMinor != nil) != manage || (detail.LatestVersion.Lines[0].UnitCostMinor != nil) != manage {
				t.Fatal("cost visibility disagrees with grants", keys, e)
			}
		} else if !errors.Is(e, pricing.ErrMissing) {
			t.Fatal("missing view allowed", keys, e)
		}
		_, e = f.pricing.Create(ctx, actor, clientAID, pricingProfile())
		if (e == nil) != (view && manage) {
			t.Fatal("create grant combination", keys, e)
		}
		_, e = f.pricing.Preview(ctx, actor, clientAID, pricingProfile())
		if (e == nil) != (view && manage) {
			t.Fatal("preview grant combination", keys, e)
		}
		_, e = f.pricing.Snapshot(ctx, actor, clientAID, copy.ID)
		if (e == nil) != bview {
			t.Fatal("snapshot requires unrelated pricing grant", keys, e)
		}
		input := pricingCopy(len(keys) + 10)
		input.CommandID = assignment
		_, e = f.pricing.Copy(ctx, actor, clientAID, m.ID, m.VersionID, m.Revision, input)
		if (e == nil) != (view && bview && bcreate) {
			t.Fatal("copy grant combination", keys, e)
		}
		if _, e = f.pricing.Detail(ctx, actor, clientBID, m.ID); !errors.Is(e, pricing.ErrMissing) {
			t.Fatal("cross-client detail leaked", e)
		}
		if _, e = f.pricing.Copy(ctx, actor, clientBID, m.ID, m.VersionID, m.Revision, input); !errors.Is(e, pricing.ErrMissing) {
			t.Fatal("cross-client copy allowed", e)
		}
	}
	actor, _ := f.grantPlanning(t, []authorization.Permission{authorization.PricingView})
	var raw []byte
	if e = f.runtime.QueryRow(ctx, `SELECT app.pricing_read($1::uuid,$2::uuid,$3::uuid,NULL)`, actor, clientAID, m.ID).Scan(&raw); e != nil || strings.Contains(string(raw), "cost") {
		t.Fatal("cost keys included for view-only actor", e)
	}
	if _, e = f.pricing.Version(ctx, f.actor, clientBID, m.ID, m.VersionID); !errors.Is(e, pricing.ErrMissing) {
		t.Fatal("global grant bypassed row binding", e)
	}
	if _, e = f.pricing.Snapshot(ctx, f.actor, clientBID, copy.ID); !errors.Is(e, pricing.ErrMissing) {
		t.Fatal("snapshot crossed clients", e)
	}
}

func TestPricingCopyIdentityArchiveAndZeroTotal(t *testing.T) {
	f := newPricingFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.createPricing(t, pricingProfile())
	input := pricingCopy(1)
	first, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, input)
	if e != nil {
		t.Fatal(e)
	}
	for _, change := range []func(*pricing.CopyInput){func(p *pricing.CopyInput) { p.InternalNote = "Different note" }, func(p *pricing.CopyInput) { p.DueDate = stringPtr("2030-01-01") }, func(p *pricing.CopyInput) { p.BillingDate = "2020-02-29" }} {
		p := input
		change(&p)
		if _, e = f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, p); !errors.Is(e, pricing.ErrConflict) {
			t.Fatal("command mismatch accepted", e)
		}
	}
	other, _ := f.grantPlanning(t, []authorization.Permission{authorization.PricingView, authorization.BillingView, authorization.BillingCreate})
	if _, e = f.pricing.Copy(ctx, other, clientAID, m.ID, m.VersionID, m.Revision, input); !errors.Is(e, pricing.ErrConflict) {
		t.Fatal("command actor changed", e)
	}
	p := pricingProfile()
	p.Lines[0].DiscountBPS = "10000"
	zero := f.createPricing(t, p)
	if _, e = f.pricing.Copy(ctx, f.actor, clientAID, zero.ID, zero.VersionID, zero.Revision, pricingCopy(2)); !errors.Is(e, pricing.ErrConflict) {
		t.Fatal("zero collection created", e)
	}
	if _, e = f.admin.Exec(ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID); e != nil {
		t.Fatal(e)
	}
	retry, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, input)
	if e != nil || !retry.Replayed || retry.ID != first.ID || f.events(t, first.ID) != 1 {
		t.Fatal("archived replay rejected or duplicated", e)
	}
	if _, e = f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, pricingCopy(3)); !errors.Is(e, pricing.ErrConflict) {
		t.Fatal("archived new copy allowed", e)
	}
	if _, e = f.pricing.Create(ctx, f.actor, clientAID, p); !errors.Is(e, pricing.ErrConflict) {
		t.Fatal("archived pricing write allowed", e)
	}
	if _, e = f.pricing.Detail(ctx, f.actor, clientAID, m.ID); e != nil {
		t.Fatal("archived pricing history lost", e)
	}
}

func TestPricingHTTPStrictInputsAuthenticationAndSafeErrors(t *testing.T) {
	f := newPricingFixture(t)
	path := "clients/" + clientAID + "/pricing"
	p := pricingProfile()
	assertStatus(t, f.request(t, nil, "GET", path, nil, nil), 401, "")
	for _, query := range []string{"limit=0", "limit=101", "limit=2&limit=3", "cursor=bad", "search=value"} {
		assertStatus(t, f.request(t, &f.login, "GET", path+"?"+query, nil, nil), 400, "")
	}
	for _, body := range []any{map[string]any{"title": "bad", "amount_minor": "10"}, pricingBody(p, "1"), map[string]any{"title": "bad", "lines": []any{map[string]any{"unit_price_minor": 1}}}} {
		assertStatus(t, f.request(t, &f.login, "POST", path, body, nil), 400, "")
	}
	assertStatus(t, f.request(t, &f.login, "POST", path, p, func(r *http.Request) { r.Header.Set("Origin", "https://wrong.example") }), 403, "")
	assertStatus(t, f.request(t, &f.login, "PUT", path, p, nil), 405, "")
	assertStatus(t, f.request(t, &f.login, "POST", path+"/preview", p, nil), 200, "")
	if strings.Contains(f.logs.String(), p.Title) || strings.Contains(f.logs.String(), p.Note) {
		t.Fatal("pricing data logged")
	}
}
