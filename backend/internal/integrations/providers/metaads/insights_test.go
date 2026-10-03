package metaads

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func expectation() Expectation {
	return Expectation{ClientID: "c1000000-0000-4000-8000-000000000001", ConnectionID: "c2000000-0000-4000-8000-000000000001",
		AccountID: "123456789", Currency: "USD", Timezone: "America/New_York", Since: "2026-03-07", Until: "2026-03-09"}
}

// Clearly synthetic string-valued rows matching the pinned generated SDK fields.
func row(date, spend, impressions, clicks string) string {
	return fmt.Sprintf(`{"account_id":"123456789","account_currency":"USD","date_start":%q,"date_stop":%q,"spend":%q,"impressions":%q,"clicks":%q}`, date, date, spend, impressions, clicks)
}
func page(rows ...string) []byte {
	return []byte(`{"data":[` + strings.Join(rows, ",") + `]}`)
}
func continuing(rows, cursor string) []byte {
	return []byte(fmt.Sprintf(`{"data":[%s],"paging":{"cursors":{"after":%q},"next":"https://synthetic.invalid/?access_token=DO_NOT_RETURN"}}`, rows, cursor))
}
func value(t *testing.T, got *string, want string) {
	t.Helper()
	if got == nil || *got != want {
		t.Fatalf("metric got %v want %s", got, want)
	}
}

func TestDailyExactWeightedTotalsAndDiscardedNavigation(t *testing.T) {
	report, err := Normalize(expectation(), [][]byte{
		continuing(row("2026-03-09", "2.00", "1", "1"), "fixture-after"),
		page(row("2026-03-07", "1.000000", "100", "1")),
	})
	if err != nil || len(report.Days) != 2 || report.Days[0].Date != "2026-03-07" || report.Days[1].Date != "2026-03-09" {
		t.Fatalf("daily calendar normalization failed: %v", err)
	}
	if report.Totals.SpendDecimal != "3" || report.Totals.Impressions != "101" || report.Totals.Clicks != "2" ||
		report.ClientID != expectation().ClientID || report.ConnectionID != expectation().ConnectionID ||
		report.Timezone != "America/New_York" || report.Attribution != "unavailable" || report.GraphVersion != "v26.0" {
		t.Fatal("source sums, binding or provenance changed")
	}
	value(t, report.Totals.CTRPercent, "1.980198")
	value(t, report.Totals.CPCDecimal, "1.500000")
	value(t, report.Totals.CPMDecimal, "29.702970")
	value(t, report.Days[0].CTRPercent, "1.000000")
	value(t, report.Days[1].CTRPercent, "100.000000")
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"DO_NOT_RETURN", "synthetic.invalid", "123456789", "fixture-after", "2026-03-08"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatal("navigation/account identity or a fabricated missing day entered the report")
		}
	}
}

func TestDecimalPrecisionBeyondFloatAndHalfUp(t *testing.T) {
	report, err := Normalize(expectation(), [][]byte{page(
		row("2026-03-07", "999999999999999999.123456", "999999999999999999", "2"),
		row("2026-03-08", "0.000001", "3", "2"),
	)})
	if err != nil || report.Totals.SpendDecimal != "999999999999999999.123457" || report.Totals.Impressions != "1000000000000000002" {
		t.Fatalf("exact source arithmetic failed: %v", err)
	}
	value(t, report.Days[1].CPCDecimal, "0.000001")
	value(t, report.Days[1].CPMDecimal, "0.000333")
	value(t, report.Days[1].CTRPercent, "66.666667")
}

func TestEmptyAndZeroDenominatorsStayExplicit(t *testing.T) {
	empty, err := Normalize(expectation(), [][]byte{page()})
	if err != nil || empty.Days == nil || len(empty.Days) != 0 || empty.Totals.SpendDecimal != "0" ||
		empty.Totals.CTRPercent != nil || empty.Totals.CPCDecimal != nil || empty.Totals.CPMDecimal != nil {
		t.Fatalf("empty response invented observations: %v", err)
	}
	for _, counts := range [][2]string{{"0", "0"}, {"0", "1"}, {"1", "0"}} {
		report, err := Normalize(expectation(), [][]byte{page(row("2026-03-07", "1", counts[0], counts[1]))})
		if err != nil || (report.Totals.CTRPercent == nil) != (counts[0] == "0") ||
			(report.Totals.CPMDecimal == nil) != (counts[0] == "0") || (report.Totals.CPCDecimal == nil) != (counts[1] == "0") {
			t.Fatal("zero denominators were converted to a metric")
		}
	}
}

func TestAtomicRejectionOfUntrustedOrIncompleteReports(t *testing.T) {
	valid := string(page(row("2026-03-07", "1.23", "10", "2")))
	cases := map[string][][]byte{
		"no pages":                    nil,
		"too many pages":              {page(), page(), page(), page(), page()},
		"oversized":                   {[]byte(strings.Repeat(" ", maxPageBytes+1))},
		"trailing":                    {[]byte(valid + `{}`)},
		"null data":                   {[]byte(`{"data":null}`)},
		"missing data":                {[]byte(`{}`)},
		"provider error":              {[]byte(`{"error":{"message":"DO_NOT_RETURN"}}`)},
		"unknown top":                 {[]byte(strings.Replace(valid, `{"data":`, `{"secret":"DO_NOT_RETURN","data":`, 1))},
		"duplicate top":               {[]byte(strings.Replace(valid, `{"data":`, `{"data":[],"data":`, 1))},
		"case alias":                  {[]byte(strings.Replace(valid, `"spend":`, `"Spend":`, 1))},
		"duplicate escaped row key":   {[]byte(strings.Replace(valid, `"spend":`, `"spend":"0","sp\u0065nd":`, 1))},
		"unknown row":                 {[]byte(strings.Replace(valid, `"spend":`, `"ad_name":"DO_NOT_RETURN","spend":`, 1))},
		"other account":               {[]byte(strings.Replace(valid, "123456789", "987654321", 1))},
		"other currency":              {[]byte(strings.Replace(valid, "USD", "EUR", 1))},
		"missing field":               {[]byte(strings.Replace(valid, `"clicks":"2"`, `"clicks":null`, 1))},
		"numeric count":               {[]byte(strings.Replace(valid, `"clicks":"2"`, `"clicks":2`, 1))},
		"out of period":               {page(row("2026-03-06", "1", "1", "1"))},
		"impossible date":             {page(row("2026-02-30", "1", "1", "1"))},
		"not daily":                   {[]byte(strings.Replace(valid, `"date_stop":"2026-03-07"`, `"date_stop":"2026-03-08"`, 1))},
		"duplicate date":              {page(row("2026-03-07", "1", "1", "1"), row("2026-03-07", "2", "2", "2"))},
		"duplicate across pages":      {continuing(row("2026-03-07", "1", "1", "1"), "after"), page(row("2026-03-07", "2", "2", "2"))},
		"incomplete":                  {continuing(row("2026-03-07", "1", "1", "1"), "after")},
		"spurious extra page":         {page(), page()},
		"empty continuation":          {continuing("", "after"), page()},
		"missing continuation cursor": {[]byte(strings.Replace(string(continuing(row("2026-03-07", "1", "1", "1"), "after")), `"after":"after"`, `"before":"before"`, 1)), page()},
		"cycle":                       {continuing(row("2026-03-07", "1", "1", "1"), "same"), continuing(row("2026-03-08", "1", "1", "1"), "same"), page()},
		"invalid utf8":                {append([]byte(valid), 0xff)},
		"null paging":                 {[]byte(strings.TrimSuffix(valid, "}") + `,"paging":null}`)},
		"duplicate cursor":            {[]byte(strings.TrimSuffix(valid, "}") + `,"paging":{"cursors":{"after":"a","after":"b"}}}`)},
	}
	for _, field := range []string{"spend", "impressions", "clicks"} {
		for _, invalid := range []string{"-1", "+1", "01", "1e3", "NaN", " 1", "1000000000000000000", "1.1234567"} {
			var fields map[string]string
			if json.Unmarshal([]byte(row("2026-03-07", "1.23", "10", "2")), &fields) != nil {
				t.Fatal("bad test fixture")
			}
			fields[field] = invalid
			raw, _ := json.Marshal(fields)
			cases[field+"/"+invalid] = [][]byte{page(string(raw))}
		}
	}
	for name, pages := range cases {
		t.Run(name, func(t *testing.T) {
			report, err := Normalize(expectation(), pages)
			if !errors.Is(err, ErrInvalid) || err.Error() != "Meta daily Insights unavailable" || !reflect.DeepEqual(report, Report{}) {
				t.Fatal("unsafe error or partial report escaped")
			}
		})
	}
}

func TestTrustedExpectationBoundariesAndCalendarLimit(t *testing.T) {
	changes := []func(*Expectation){
		func(e *Expectation) { e.ClientID = "00000000-0000-0000-0000-000000000000" },
		func(e *Expectation) { e.ConnectionID = "C2000000-0000-4000-8000-000000000001" },
		func(e *Expectation) { e.AccountID = "act_123456789" },
		func(e *Expectation) { e.AccountID = "0123456789" },
		func(e *Expectation) { e.Currency = "usd" },
		func(e *Expectation) { e.Timezone = "Local" },
		func(e *Expectation) { e.Timezone = "Imaginary/Zone" },
		func(e *Expectation) { e.Since = "2026-3-7" },
		func(e *Expectation) { e.Since = "2026-03-10" },
		func(e *Expectation) { e.Until = "2026-04-07" },
	}
	for i, change := range changes {
		e := expectation()
		change(&e)
		if report, err := Normalize(e, [][]byte{page()}); err != ErrInvalid || !reflect.DeepEqual(report, Report{}) {
			t.Fatalf("invalid trusted expectation %d passed", i)
		}
	}
	e := expectation()
	e.Since, e.Until = "2026-03-01", "2026-03-31"
	rows := make([]string, 31)
	for i := range rows {
		rows[i] = row(fmt.Sprintf("2026-03-%02d", i+1), "0.01", "1", "0")
	}
	if report, err := Normalize(e, [][]byte{page(rows...)}); err != nil || len(report.Days) != 31 || report.Totals.SpendDecimal != "0.31" {
		t.Fatalf("31 account-local days across DST failed: %v", err)
	}
	rows = append(rows, row("2026-03-31", "1", "1", "1"))
	if _, err := Normalize(e, [][]byte{page(rows...)}); err != ErrInvalid {
		t.Fatal("row limit failed")
	}
}

func FuzzNormalizeNeverReturnsRawFailures(f *testing.F) {
	f.Add(page(row("2026-03-07", "1", "2", "1")))
	f.Add([]byte(`{"data":[]}`))
	f.Add([]byte(`{"error":{"message":"SECRET"}}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		report, err := Normalize(expectation(), [][]byte{raw})
		if err != nil && (err != ErrInvalid || !reflect.DeepEqual(report, Report{})) {
			t.Fatal("raw failure or partial result")
		}
		if err == nil && (len(report.Days) > 31 || report.ClientID != expectation().ClientID || report.Currency != "USD") {
			t.Fatal("normalization lost its bound or trusted identity")
		}
	})
}
