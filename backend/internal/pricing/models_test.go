package pricing

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func profile() Profile {
	return Profile{Title: "Synthetic agreement", Currency: "USD", EffectiveFrom: "2020-02-29", Lines: []LineInput{{Description: "Synthetic service", Kind: "recurring", Frequency: "monthly", QuantityMicros: "1000000", UnitPriceMinor: "100", DiscountBPS: "0", TaxBPS: "0"}}}
}
func TestExactCalculationRoundingOrderAndCurrencyScales(t *testing.T) {
	for _, currency := range []string{"USD", "EUR", "GBP", "TRY", "JPY", "KWD"} {
		p := profile()
		p.Currency = currency
		p.Lines[0].QuantityMicros = "1500000"
		p.Lines[0].UnitPriceMinor = "1"
		p.Lines[0].DiscountBPS = "2500"
		p.Lines[0].TaxBPS = "10000"
		cost := "3"
		p.Lines[0].UnitCostMinor = &cost
		r, e := Calculate(p)
		if e != nil || r.BaseMinor != "2" || r.DiscountMinor != "1" || r.NetMinor != "1" || r.TaxMinor != "1" || r.TotalMinor != "2" || r.CostMinor == nil || *r.CostMinor != "5" {
			t.Fatal(currency, r, e)
		}
		exp, _ := exponent(currency)
		if r.CurrencyExponent != exp {
			t.Fatal("wrong currency scale")
		}
	}
	p := profile()
	p.Lines[0].QuantityMicros = "500000"
	p.Lines[0].UnitPriceMinor = "1"
	p.Lines = append(p.Lines, p.Lines[0])
	r, e := Calculate(p)
	if e != nil || r.BaseMinor != "2" || r.Lines[0].BaseMinor != "1" || r.Lines[1].Position != 2 {
		t.Fatal("rounded sum differs from rounded lines", r, e)
	}
	p.Lines[0].DiscountBPS = "10000"
	p.Lines[1].DiscountBPS = "10000"
	r, e = Calculate(p)
	if e != nil || r.TotalMinor != "0" {
		t.Fatal("fully discounted agreement invalid", e)
	}
}
func TestExactCalculationInt64BoundsAndUnknownCost(t *testing.T) {
	p := profile()
	p.Lines[0].UnitPriceMinor = "9223372036854775807"
	r, e := Calculate(p)
	if e != nil || r.TotalMinor != "9223372036854775807" {
		t.Fatal("wide intermediate rejected", e)
	}
	p.Lines[0].TaxBPS = "1"
	if _, e = Calculate(p); !errors.Is(e, ErrInvalid) {
		t.Fatal("total overflow accepted")
	}
	p = profile()
	p.Lines[0].QuantityMicros = "9223372036854775807"
	p.Lines[0].UnitPriceMinor = "9223372036854775807"
	if _, e = Calculate(p); !errors.Is(e, ErrInvalid) {
		t.Fatal("base overflow accepted")
	}
	p = profile()
	p.Lines[0].UnitPriceMinor = "4611686018427387904"
	p.Lines = append(p.Lines, p.Lines[0])
	if _, e = Calculate(p); !errors.Is(e, ErrInvalid) {
		t.Fatal("aggregate overflow accepted")
	}
	p = profile()
	cost := "50"
	p.Lines[0].UnitCostMinor = &cost
	p.Lines = append(p.Lines, p.Lines[0])
	p.Lines[1].UnitCostMinor = nil
	r, e = Calculate(p)
	if e != nil || r.CostMinor != nil || r.Lines[0].CostMinor == nil {
		t.Fatal("missing cost treated as zero", e)
	}
}
func TestPricingRejectsNoncanonicalNumbersAndInvalidProfiles(t *testing.T) {
	for _, v := range []string{"", "01", "-1", "+1", "1.0", "1e3", " 1", "9223372036854775808", strings.Repeat("9", 100), "١"} {
		p := profile()
		p.Lines[0].UnitPriceMinor = v
		if _, e := Calculate(p); !errors.Is(e, ErrInvalid) {
			t.Fatal(v, e)
		}
	}
	for _, mutate := range []func(*Profile){
		func(p *Profile) { p.Lines[0].QuantityMicros = "0" }, func(p *Profile) { p.Lines[0].TaxBPS = "10001" }, func(p *Profile) { p.Lines[0].DiscountBPS = "10001" }, func(p *Profile) { p.Lines[0].Frequency = "none" }, func(p *Profile) { p.Lines[0].Kind = "one_time" }, func(p *Profile) { p.Lines[0].Description = "bad\tcontrol" }, func(p *Profile) { p.Currency = "CHF" }, func(p *Profile) { p.Lines = nil }, func(p *Profile) { p.Lines = make([]LineInput, 51) }, func(p *Profile) { p.EffectiveFrom = "2025-02-29" }, func(p *Profile) { v := p.EffectiveFrom; p.EffectiveUntil = &v }, func(p *Profile) { p.Title = "\n" },
	} {
		p := profile()
		mutate(&p)
		if _, e := normalize(p); !errors.Is(e, ErrInvalid) {
			t.Fatal("invalid profile accepted", p, e)
		}
	}
	p := profile()
	p.Title = " trimmed "
	p.Lines[0].Description = " trimmed "
	normalized, e := normalize(p)
	if e != nil || normalized.Title != "trimmed" || p.Lines[0].Description != " trimmed " {
		t.Fatal("normalization mutated caller", e)
	}
}
func TestPricingPaginationStrictnessAndConstruction(t *testing.T) {
	for _, query := range []string{"limit=0", "limit=101", "limit=", "limit=2&limit=3", "cursor=invalid", "search=synthetic", "limit=%xx"} {
		if _, _, e := parsePage(httptest.NewRequest("GET", "/?"+query, nil)); !errors.Is(e, ErrInvalid) {
			t.Fatal(query, e)
		}
	}
	if cursor, limit, e := parsePage(httptest.NewRequest("GET", "/", nil)); e != nil || limit != 25 || cursor != "" {
		t.Fatal(cursor, limit, e)
	}
	if _, e := NewService(nil); !errors.Is(e, ErrInvalid) {
		t.Fatal("nil pool accepted")
	}
	if _, e := NewHandler(nil, nil, nil); !errors.Is(e, ErrInvalid) {
		t.Fatal("nil handlers accepted")
	}
}
