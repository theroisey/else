//go:build integration

package integration

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/pricing"
)

func TestPricingSQLRepeatsExactValidationAndMatchesWideCalculations(t *testing.T) {
	f := newPricingFixture(t)
	ctx := correlation.New(f.base.ctx)
	for _, currency := range []string{"USD", "EUR", "GBP", "TRY", "JPY", "KWD"} {
		for _, price := range []string{"0", "1", "9007199254740993", "9223372036854775807"} {
			p := pricingProfile()
			p.Currency = currency
			p.Lines[0].QuantityMicros = "1000000"
			p.Lines[0].UnitPriceMinor = price
			p.Lines[0].DiscountBPS = "0"
			p.Lines[0].TaxBPS = "0"
			got, e := f.pricing.Preview(ctx, f.actor, clientAID, p)
			want, we := pricing.Calculate(p)
			if e != nil || we != nil || got.TotalMinor != want.TotalMinor || got.CurrencyExponent != want.CurrencyExponent {
				t.Fatal("wide SQL calculation differs", currency, price, e)
			}
		}
	}
	for _, value := range []any{"01", "1e2", "-1", "9223372036854775808", 1, nil} {
		p := pricingBody(pricingProfile(), "1")
		delete(p, "expected_revision")
		lines := p["lines"].([]any)
		lines[0].(map[string]any)["unit_price_minor"] = value
		raw, _ := json.Marshal(p)
		if _, e := f.runtime.Exec(ctx, `SELECT app.pricing_preview($1::uuid,$2::uuid,$3::jsonb)`, f.actor, clientAID, raw); e == nil {
			t.Fatal("SQL accepted noncanonical number", value)
		}
	}
	for _, mutate := range []func(*pricing.Profile){func(p *pricing.Profile) {
		p.Lines[0].QuantityMicros = "9223372036854775807"
		p.Lines[0].UnitPriceMinor = "9223372036854775807"
	}, func(p *pricing.Profile) {
		p.Lines[0].UnitPriceMinor = "9223372036854775807"
		p.Lines[0].QuantityMicros = "1000000"
		p.Lines[0].DiscountBPS = "0"
		p.Lines[0].TaxBPS = "1"
	}, func(p *pricing.Profile) { p.EffectiveFrom = "2025-02-29" }, func(p *pricing.Profile) { p.Lines[0].DiscountBPS = "10001" }, func(p *pricing.Profile) { p.Lines[0].Kind = "one_time" }} {
		p := pricingProfile()
		mutate(&p)
		raw, _ := json.Marshal(p)
		if _, e := f.runtime.Exec(ctx, `SELECT app.pricing_preview($1::uuid,$2::uuid,$3::jsonb)`, f.actor, clientAID, raw); e == nil {
			t.Fatal("SQL accepted invalid profile")
		}
	}
}

func TestPricingAuditFailureRollsBackVersionsAndCompleteBillingCopies(t *testing.T) {
	f := newPricingFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.createPricing(t, pricingProfile())
	first, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, pricingCopy(1))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.admin.Exec(ctx, "REVOKE INSERT "+auditColumns+" ON app.audit_events FROM "+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	p := pricingProfile()
	p.EffectiveFrom = today()
	for _, write := range []func() error{func() error { _, e := f.pricing.Create(ctx, f.actor, clientAID, p); return e }, func() error { _, e := f.pricing.Append(ctx, f.actor, clientAID, m.ID, m.Revision, p); return e }, func() error {
		_, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, pricingCopy(2))
		return e
	}} {
		if write() == nil {
			t.Fatal("unaudited pricing write committed")
		}
	}
	var sheets, versions, lines, collections, copies, copiedLines int
	if e = f.admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM app.pricing_sheets),(SELECT count(*) FROM app.pricing_versions),(SELECT count(*) FROM app.pricing_lines),(SELECT count(*) FROM app.collections),(SELECT count(*) FROM app.pricing_snapshots),(SELECT count(*) FROM app.pricing_snapshot_lines)`).Scan(&sheets, &versions, &lines, &collections, &copies, &copiedLines); e != nil || sheets != 1 || versions != 1 || lines != 1 || collections != 1 || copies != 1 || copiedLines != 1 {
		t.Fatal("partial pricing/audit rollback", sheets, versions, lines, collections, copies, copiedLines, e)
	}
	detail, e := f.pricing.Detail(ctx, f.actor, clientAID, m.ID)
	if e != nil || detail.Revision != "1" || f.events(t, m.ID) != 1 || f.events(t, first.ID) != 1 {
		t.Fatal("failed append advanced history", e)
	}
	replay, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, pricingCopy(1))
	if e != nil || !replay.Replayed {
		t.Fatal("read-only reconciliation needed audit insert", e)
	}
}

func TestPricingStorageHistoryReferencesAndRuntimeBoundaries(t *testing.T) {
	f := newPricingFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.createPricing(t, pricingProfile())
	c, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, pricingCopy(1))
	if e != nil {
		t.Fatal(e)
	}
	for _, table := range []string{"pricing_sheets", "pricing_versions", "pricing_lines", "pricing_snapshots", "pricing_snapshot_lines"} {
		for _, sql := range []string{"SELECT * FROM app." + table, "DELETE FROM app." + table, "TRUNCATE app." + table} {
			if _, e = f.runtime.Exec(ctx, sql); e == nil {
				t.Fatal("runtime reached private pricing storage", sql)
			}
		}
		for _, sql := range []string{"DELETE FROM app." + table, "TRUNCATE app." + table} {
			if _, e = f.admin.Exec(ctx, sql); e == nil {
				t.Fatal("owner rewrote retained history", sql)
			}
		}
	}
	for _, sql := range []string{`SELECT app.pricing_calculate('{}'::jsonb)`, `SELECT app.pricing_version_document($1::uuid,true)`} {
		var args []any
		if strings.Contains(sql, "$1") {
			args = []any{m.VersionID}
		}
		if _, e = f.runtime.Exec(ctx, sql, args...); e == nil {
			t.Fatal("runtime reached unguarded projector")
		}
	}
	for _, sql := range []string{`UPDATE app.pricing_versions SET title='rewrite'`, `UPDATE app.pricing_lines SET unit_price_minor=1`, `UPDATE app.pricing_snapshots SET total_minor=1`, `UPDATE app.pricing_snapshot_lines SET total_minor=1`, `UPDATE app.pricing_sheets SET currency='JPY'`, `UPDATE app.collections SET amount_minor=126 WHERE id=$1::uuid`} {
		var args []any
		if strings.Contains(sql, "$1") {
			args = []any{c.ID}
		}
		if _, e = f.admin.Exec(ctx, sql, args...); e == nil {
			t.Fatal("retained financial values changed", sql)
		}
	}
	// A later line cannot be appended even if it is zero and sums still match.
	if _, e = f.admin.Exec(ctx, `INSERT INTO app.pricing_lines SELECT version_id,2,'Injected zero line',kind,frequency,quantity_micros,0,0,0,NULL,0,0,0,0,0,NULL FROM app.pricing_lines WHERE version_id=$1::uuid`, m.VersionID); e == nil {
		t.Fatal("zero line appended to committed version")
	}
	// Even a privileged creation transaction must preserve complete exact sums.
	tx, e := f.admin.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	raw, _ := json.Marshal(pricingProfile())
	if _, e = tx.Exec(ctx, `SELECT app.pricing_write($1::uuid,$2::uuid,$3::uuid,$4::uuid,0,$5::jsonb)`, f.actor, clientAID, fixtureID, "c2000000-0000-4000-8000-000000000001", raw); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, `INSERT INTO app.pricing_lines SELECT version_id,2,'Injected line',kind,frequency,quantity_micros,unit_price_minor,discount_bps,tax_bps,unit_cost_minor,base_minor,discount_minor,net_minor,tax_minor,total_minor,cost_minor FROM app.pricing_lines WHERE version_id=$1::uuid`, "c2000000-0000-4000-8000-000000000001"); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e == nil {
		t.Fatal("direct line insert corrupted immutable version totals")
	}
	if _, e = f.admin.Exec(ctx, `INSERT INTO app.pricing_snapshot_lines SELECT collection_id,2,description,kind,frequency,quantity_micros,unit_price_minor,discount_bps,tax_bps,base_minor,discount_minor,net_minor,tax_minor,total_minor FROM app.pricing_snapshot_lines WHERE collection_id=$1::uuid`, c.ID); e == nil {
		t.Fatal("extra snapshot line committed")
	}
}

func TestPricingMigrationEmptyDownUpPreservesFinanceAndRefusesHistory(t *testing.T) {
	for _, history := range []string{"empty", "pricing", "snapshot", "audit-only"} {
		t.Run(history, func(t *testing.T) {
			f := newPricingFixture(t)
			ctx := correlation.New(f.base.ctx)
			finance := f.createCollection(t, billingProfile())
			before := f.collection(t, finance)
			switch history {
			case "pricing", "snapshot":
				m := f.createPricing(t, pricingProfile())
				if history == "snapshot" {
					if _, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, pricingCopy(1)); e != nil {
						t.Fatal(e)
					}
				}
			case "audit-only":
				if _, e := f.runtime.Exec(ctx, `INSERT INTO app.audit_events `+auditColumns+` VALUES('user',$1::uuid,'pricing.created','pricing',$2::uuid,$3::uuid,$4,'null','{"exists":true,"revision":1}','{"source":"http"}')`, f.actor, fixtureID, clientAID, correlation.ID(ctx)); e != nil {
					t.Fatal(e)
				}
			}
			p := provider(t, f.base)
			_, e := p.DownTo(ctx, 12)
			if history == "empty" {
				if e != nil {
					t.Fatal(e)
				}
				if _, e = p.Up(ctx); e != nil {
					t.Fatal(e)
				}
				if _, e = f.pricing.List(ctx, f.actor, clientAID, "", 25); e == nil {
					t.Fatal("new functions inherited runtime grants")
				}
				if _, e = f.admin.Exec(ctx, `GRANT EXECUTE ON FUNCTION `+pricingFunctions+` TO `+f.runtimeRole); e != nil {
					t.Fatal(e)
				}
				if _, e = f.pricing.List(ctx, f.actor, clientAID, "", 25); e != nil {
					t.Fatal(e)
				}
			} else if e == nil {
				t.Fatal("rollback removed retained history")
			}
			after := f.collection(t, finance)
			if before != after {
				t.Fatal("pricing migration changed original collection")
			}
			var permissions int
			if e = f.admin.QueryRow(ctx, `SELECT count(*) FROM app.permissions`).Scan(&permissions); e != nil || permissions != 33 {
				t.Fatal("pricing expanded grants", e)
			}
		})
	}
}

func TestPricingStaleRevisionDoesNotWriteOrCopy(t *testing.T) {
	f := newPricingFixture(t)
	ctx := correlation.New(f.base.ctx)
	m := f.createPricing(t, pricingProfile())
	p := pricingProfile()
	p.EffectiveFrom = today()
	if _, e := f.pricing.Append(ctx, f.actor, clientAID, m.ID, m.Revision, p); e != nil {
		t.Fatal(e)
	}
	if _, e := f.pricing.Append(ctx, f.actor, clientAID, m.ID, m.Revision, p); !errors.Is(e, pricing.ErrConflict) {
		t.Fatal("stale append accepted", e)
	}
	if _, e := f.pricing.Copy(ctx, f.actor, clientAID, m.ID, m.VersionID, m.Revision, pricingCopy(1)); !errors.Is(e, pricing.ErrConflict) {
		t.Fatal("stale copy accepted", e)
	}
	if f.events(t, m.ID) != 2 {
		t.Fatal("failed append audited")
	}
}
