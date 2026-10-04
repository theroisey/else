package woocommerce

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"strings"
	"testing"
)

func expectation() Expectation {
	return Expectation{ClientID: "a1000000-0000-4000-8000-000000000001", ConnectionID: "a2000000-0000-4000-8000-000000000001", Currency: "USD", Start: "2026-10-01T00:00:00Z", End: "2026-10-02T00:00:00Z", PerPage: 100}
}

const order = `{"id":1,"status":"pending","currency":"USD","date_created_gmt":"2026-10-01T00:00:00","total":"100.010000","refunds":[{"id":10,"total":"-1.010000"}]}`
const refund = `{"id":10,"parent_id":1,"date_created_gmt":"2026-10-01T12:00:00","amount":"1.010000"}`

func page(raw string) []Page {
	return []Page{{Number: 1, Total: "1", TotalPages: "1", Body: []byte("[" + raw + "]")}}
}
func parents() []Parent { return []Parent{{ID: "1", Currency: "USD"}} }

func TestOrderCohortExactMoneyAndNoStatusRevenueInference(t *testing.T) {
	for _, status := range []string{"pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "trash"} {
		r, err := NormalizeOrders(expectation(), page(strings.Replace(order, `"pending"`, `"`+status+`"`, 1)))
		if err != nil || len(r.Orders) != 1 || r.Orders[0].Status != status || r.GrandTotalMinor != "10001" || r.LifetimeRefundMinor != "101" || r.RemainderMinor != "9900" || r.Orders[0].CreatedAt != "2026-10-01T00:00:00Z" || r.ClientID != expectation().ClientID || r.ConnectionID != expectation().ConnectionID || r.APIVersion != APIVersion {
			t.Fatal("observed order cohort or exact arithmetic differs")
		}
		encoded, _ := json.Marshal(r)
		for _, unwanted := range []string{"revenue", "paid", "billing", "reason", "provider_account", "shop_url"} {
			if bytes.Contains(encoded, []byte(unwanted)) {
				t.Fatal("order projection invented semantics or retained private data")
			}
		}
	}
	for _, tc := range []struct {
		currency, total, refunded, wantTotal, wantRefund string
		exponent                                         int
	}{
		{"USD", "9007199254740991.010000", "1.010000", "900719925474099101", "101", 2},
		{"EUR", "1.020000", "0.010000", "102", "1", 2},
		{"GBP", "1.020000", "0.010000", "102", "1", 2},
		{"TRY", "1.020000", "0.010000", "102", "1", 2},
		{"JPY", "9007199254740993.000000", "1.000000", "9007199254740993", "1", 0},
		{"KWD", "1.234000", "0.001000", "1234", "1", 3},
		{"USD", "0.000000", "0.000000", "0", "0", 2},
	} {
		e := expectation()
		e.Currency = tc.currency
		raw := strings.ReplaceAll(order, `"USD"`, `"`+tc.currency+`"`)
		raw = strings.Replace(raw, "100.010000", tc.total, 1)
		raw = strings.Replace(raw, "-1.010000", "-"+tc.refunded, 1)
		r, err := NormalizeOrders(e, page(raw))
		if err != nil || r.CurrencyExponent != tc.exponent || r.GrandTotalMinor != tc.wantTotal || r.LifetimeRefundMinor != tc.wantRefund {
			t.Fatal("exact zero/two/three-place currency failed")
		}
	}
}

func TestRefundPeriodIsSeparateAndParentCurrencyIsRequired(t *testing.T) {
	r, err := NormalizeRefunds(expectation(), page(refund), parents())
	if err != nil || r.AmountMinor != "101" || len(r.Refunds) != 1 || r.Refunds[0].ID != "10" || r.Refunds[0].ParentID != "1" || r.Refunds[0].CreatedAt != "2026-10-01T12:00:00Z" {
		t.Fatal("separately dated refund failed")
	}
	// Parent 12345 can predate the requested period; there is no date/order-cohort
	// inference in this binding projection and no assumed shop-default currency.
	raw := strings.Replace(refund, `"parent_id":1`, `"parent_id":12345`, 1)
	if _, err := NormalizeRefunds(expectation(), page(raw), []Parent{{"12345", "USD"}}); err != nil {
		t.Fatal("refund required parent to be in order-created cohort")
	}
	for _, p := range [][]Parent{nil, {{"1", "EUR"}}, {{"2", "USD"}}, {{"1", "USD"}, {"1", "USD"}}, {{"1", "USD"}, {"2", "USD"}}, {{"01", "USD"}}, {{"0", "USD"}}} {
		assertRefundFailure(t, expectation(), page(refund), p)
	}
	for _, amount := range []string{"-1.010000", "1.001000", "1.01", "1e2", "NaN", "10000000000000000.000000"} {
		assertRefundFailure(t, expectation(), page(strings.Replace(refund, "1.010000", amount, 1)), parents())
	}
}

func TestCompletePagingEmptyAndExactSumsBeyondFloat(t *testing.T) {
	e := expectation()
	e.PerPage = 1
	second := strings.Replace(order, `"id":1,`, `"id":2,`, 1)
	second = strings.Replace(second, `"id":10,`, `"id":11,`, 1)
	pages := []Page{{1, "2", "2", []byte("[" + order + "]")}, {2, "2", "2", []byte("[" + second + "]")}}
	r, err := NormalizeOrders(e, pages)
	if err != nil || len(r.Orders) != 2 || r.GrandTotalMinor != "20002" || r.LifetimeRefundMinor != "202" || r.RemainderMinor != "19800" {
		t.Fatal("complete page sequence failed")
	}
	for _, mutate := range []func([]Page){
		func(p []Page) { p[1].Number = 1 }, func(p []Page) { p[1].Total = "1" }, func(p []Page) { p[1].TotalPages = "1" },
		func(p []Page) { p[0].TotalPages = "3"; p[1].TotalPages = "3" }, func(p []Page) { p[0].Body = []byte("[]") },
		func(p []Page) { p[1].Body = p[0].Body }, func(p []Page) { p[0], p[1] = p[1], p[0]; p[0].Number = 1; p[1].Number = 2 },
		func(p []Page) { p[0].Total = "02" }, func(p []Page) { p[0].Total = "501" }, func(p []Page) { p[0].Body = bytes.Repeat([]byte(" "), 65537) },
	} {
		copied := append([]Page(nil), pages...)
		mutate(copied)
		assertOrderFailure(t, e, copied)
	}
	assertOrderFailure(t, e, pages[:1])
	assertOrderFailure(t, e, nil)
	empty := []Page{{1, "0", "0", []byte("[]")}}
	o, err := NormalizeOrders(e, empty)
	if err != nil || o.Orders == nil || len(o.Orders) != 0 || o.GrandTotalMinor != "0" || o.LifetimeRefundMinor != "0" || o.RemainderMinor != "0" {
		t.Fatal("complete empty order response differs")
	}
	ref, err := NormalizeRefunds(e, empty, nil)
	if err != nil || ref.Refunds == nil || len(ref.Refunds) != 0 || ref.AmountMinor != "0" {
		t.Fatal("complete empty refund response differs")
	}
	// Five maximum pages / 500 rows; each amount remains exactly representable in
	// the contract while the sum exceeds an item and IEEE-754 precision.
	e.PerPage = 100
	pages = nil
	for p := 0; p < 5; p++ {
		var rows []string
		for i := 0; i < 100; i++ {
			rows = append(rows, fmt.Sprintf(`{"id":%d,"status":"completed","currency":"USD","date_created_gmt":"2026-10-01T01:00:00","total":"9999999999999999.990000","refunds":[]}`, p*100+i+1))
		}
		pages = append(pages, Page{p + 1, "500", "5", []byte("[" + strings.Join(rows, ",") + "]")})
	}
	o, err = NormalizeOrders(e, pages)
	if err != nil || len(o.Orders) != 500 || o.GrandTotalMinor != "499999999999999999500" {
		t.Fatal("maximum bounded exact sum differs")
	}
}

func TestStrictOrdersAtomicRejection(t *testing.T) {
	for _, tc := range []struct{ old, replacement string }{
		{`"id":1`, `"id":"1"`}, {`"id":1`, `"id":1.0`}, {`"id":1`, `"id":0`}, {`"id":1`, `"id":1,"\u0069d":2`},
		{`"id":1`, `"ID":1`}, {`"id":1`, `"id":1,"email":"private"`},
		{`"currency":"USD"`, `"currency":"EUR"`}, {`"status":"pending"`, `"status":"custom-paid"`},
		{`"total":"100.010000"`, `"total":null`}, {`"total":"100.010000"`, `"total":100.01`},
		{"100.010000", "-100.010000"}, {"100.010000", "0100.010000"}, {"100.010000", "100.010001"}, {"100.010000", "100.01"},
		{`"refunds":[{"id":10,"total":"-1.010000"}]`, `"refunds":null`},
		{"-1.010000", "1.010000"}, {"-1.010000", "-101.010000"},
		{`"id":10,"total"`, `"id":10,"reason":"private","total"`},
		{"2026-10-01T00:00:00", "2026-10-02T00:00:00"}, {"2026-10-01T00:00:00", "2026-09-30T23:59:59"},
		{"2026-10-01T00:00:00", "2026-10-01T00:00:00Z"}, {"2026-10-01T00:00:00", "2026-02-30T00:00:00"},
	} {
		assertOrderFailure(t, expectation(), page(strings.Replace(order, tc.old, tc.replacement, 1)))
	}
	for _, raw := range []string{"null", "{}", "[null]", "[" + order + "] trailing", "[" + order + "][]", string([]byte{'[', '"', 0xff, '"', ']'})} {
		assertOrderFailure(t, expectation(), []Page{{1, "1", "1", []byte(raw)}})
	}
	for _, mutate := range []func(*Expectation){
		func(e *Expectation) { e.ClientID = "00000000-0000-0000-0000-000000000000" }, func(e *Expectation) { e.ConnectionID = "other" },
		func(e *Expectation) { e.Currency = "BTC" }, func(e *Expectation) { e.PerPage = 0 }, func(e *Expectation) { e.PerPage = 101 },
		func(e *Expectation) { e.End = e.Start }, func(e *Expectation) { e.End = "2026-12-01T00:00:00Z" },
		func(e *Expectation) { e.Start = "2026-10-01T00:00:00+00:00" }, func(e *Expectation) { e.Start = "2026-10-01T00:00:00.1Z" },
	} {
		e := expectation()
		mutate(&e)
		assertOrderFailure(t, e, page(order))
		assertRefundFailure(t, e, page(refund), parents())
	}
}

func TestStrictRefundsNoPartialOutput(t *testing.T) {
	for _, tc := range []struct{ old, replacement string }{
		{`"id":10`, `"id":10,"id":11`}, {`"id":10`, `"id":1`}, {`"parent_id":1`, `"parent_id":"1"`},
		{`"amount":"1.010000"`, `"amount":null`}, {`"amount":"1.010000"`, `"amount":1.01`},
		{`"id":10`, `"id":10,"reason":"private"`}, {`"id":10`, `"Id":10`},
		{"2026-10-01T12:00:00", "2026-10-02T00:00:00"},
	} {
		assertRefundFailure(t, expectation(), page(strings.Replace(refund, tc.old, tc.replacement, 1)), parents())
	}
	e := expectation()
	e.PerPage = 1
	pages := []Page{{1, "2", "2", []byte("[" + refund + "]")}, {2, "2", "2", []byte("[" + refund + "]")}}
	assertRefundFailure(t, e, pages, parents())
	pages[1].Body = []byte("[" + strings.Replace(refund, `"id":10`, `"id":11`, 1) + "]")
	r, err := NormalizeRefunds(e, pages, parents())
	if err != nil || r.AmountMinor != "202" || len(r.Refunds) != 2 {
		t.Fatal("same-parent distinct refund events failed")
	}
}

func TestOrderRefundIdentityAndNestedBound(t *testing.T) {
	assertOrderFailure(t, expectation(), page(strings.Replace(order, `"id":10`, `"id":1`, 1)))
	second := strings.Replace(order, `"id":1,`, `"id":10,`, 1)
	second = strings.Replace(second, `"id":10,"total"`, `"id":11,"total"`, 1)
	assertOrderFailure(t, expectation(), []Page{{1, "2", "1", []byte("[" + order + "," + second + "]")}})
	var summaries []string
	for i := 0; i < 50; i++ {
		summaries = append(summaries, fmt.Sprintf(`{"id":%d,"total":"-0.000000"}`, i+100))
	}
	raw := strings.Replace(order, `[{"id":10,"total":"-1.010000"}]`, "["+strings.Join(summaries, ",")+"]", 1)
	if _, err := NormalizeOrders(expectation(), page(raw)); err != nil {
		t.Fatal("bounded zero refund summaries rejected")
	}
	raw = strings.Replace(raw, strings.Join(summaries, ","), strings.Join(summaries, ",")+`,{"id":999,"total":"-0.000000"}`, 1)
	assertOrderFailure(t, expectation(), page(raw))
}

func assertOrderFailure(t *testing.T, e Expectation, p []Page) {
	t.Helper()
	r, err := NormalizeOrders(e, p)
	if err != ErrUnavailable || !reflect.DeepEqual(r, OrderReport{}) || err.Error() != "WooCommerce report unavailable" {
		t.Fatal("invalid order input returned partial data or unsafe error")
	}
}
func assertRefundFailure(t *testing.T, e Expectation, p []Page, parents []Parent) {
	t.Helper()
	r, err := NormalizeRefunds(e, p, parents)
	if err != ErrUnavailable || !reflect.DeepEqual(r, RefundReport{}) {
		t.Fatal("invalid refund input returned partial data or unsafe error")
	}
}

func FuzzReportAtomicity(f *testing.F) {
	f.Add([]byte("[" + order + "]"))
	f.Add([]byte("[" + refund + "]"))
	f.Add([]byte("null"))
	f.Add([]byte("[{}]"))
	f.Fuzz(func(t *testing.T, data []byte) {
		p := []Page{{1, "1", "1", data}}
		o, err := NormalizeOrders(expectation(), p)
		if err != nil {
			if err != ErrUnavailable || !reflect.DeepEqual(o, OrderReport{}) {
				t.Fatal("fuzzed orders escaped atomic fixed failure")
			}
		} else {
			if len(o.Orders) != 1 || o.Currency != "USD" || o.ClientID != expectation().ClientID {
				t.Fatal("fuzzed order report escaped expected binding")
			}
			gross, a := new(big.Int).SetString(o.GrandTotalMinor, 10)
			ref, b := new(big.Int).SetString(o.LifetimeRefundMinor, 10)
			net, c := new(big.Int).SetString(o.RemainderMinor, 10)
			if !a || !b || !c || net.Sign() < 0 || new(big.Int).Add(ref, net).Cmp(gross) != 0 {
				t.Fatal("fuzzed exact cohort arithmetic differs")
			}
		}
		r, err := NormalizeRefunds(expectation(), p, parents())
		if err != nil {
			if err != ErrUnavailable || !reflect.DeepEqual(r, RefundReport{}) {
				t.Fatal("fuzzed refunds escaped atomic fixed failure")
			}
		} else if len(r.Refunds) != 1 || r.Refunds[0].ParentID != "1" || r.AmountMinor != r.Refunds[0].AmountMinor {
			t.Fatal("fuzzed refund report escaped binding/arithmetic")
		}
	})
}
