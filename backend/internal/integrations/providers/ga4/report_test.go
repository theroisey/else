package ga4

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// Names/data are synthetic contract fixtures, not a verified metric catalog.
func expectation() Expectation {
	return Expectation{ClientID: "00000000-0000-4000-8000-000000000001", ConnectionID: "00000000-0000-4000-8000-000000000002",
		PropertyID: "1234", Timezone: "America/New_York", Since: "2026-03-07", Until: "2026-03-09", Limit: 2,
		Dimensions: []Dimension{{Name: "syntheticGroup", Compatibility: "COMPATIBLE"}},
		Metrics:    []Metric{{Name: "syntheticCount", Type: "TYPE_INTEGER", Compatibility: "COMPATIBLE"}}}
}

func fixture(offset, total int, labels ...string) Page {
	rows := make([]any, 0, len(labels))
	for _, label := range labels {
		rows = append(rows, map[string]any{"dimensionValues": []any{map[string]any{"value": label}}, "metricValues": []any{map[string]any{"value": "9007199254740993"}}})
	}
	body, _ := json.Marshal(map[string]any{
		"kind": "analyticsData#runReport", "dimensionHeaders": []any{map[string]any{"name": "syntheticGroup"}},
		"metricHeaders": []any{map[string]any{"name": "syntheticCount", "type": "TYPE_INTEGER"}}, "rows": rows, "rowCount": total,
		"metadata": map[string]any{"timeZone": "America/New_York"},
	})
	return Page{Offset: offset, Body: body}
}

func replace(p Page, before, after string) Page {
	p.Body = []byte(strings.Replace(string(p.Body), before, after, 1))
	return p
}

func unavailable(t *testing.T, e Expectation, pages []Page) {
	t.Helper()
	r, err := NormalizeIntegerReport(e, pages)
	if err != ErrUnavailable || !reflect.DeepEqual(r, Report{}) {
		t.Fatal("unsupported report must fail atomically with fixed safe error")
	}
}

func TestCompleteIntegerReport(t *testing.T) {
	e := expectation()
	pages := []Page{fixture(0, 3, "group A", "(not set)"), fixture(2, 3, "group C")}
	r, err := NormalizeIntegerReport(e, pages)
	if err != nil || r.ClientID != e.ClientID || r.ConnectionID != e.ConnectionID || r.APIVersion != "v1beta" ||
		r.Timezone != e.Timezone || r.Since != e.Since || r.Until != e.Until || len(r.Rows) != 3 ||
		!reflect.DeepEqual(r.Dimensions, []string{"syntheticGroup"}) || !reflect.DeepEqual(r.Metrics, []string{"syntheticCount"}) ||
		r.Rows[1].Dimensions[0] != "(not set)" || r.Rows[0].Metrics[0] != "9007199254740993" {
		t.Fatal("complete ordered bound report differs")
	}
	// No property ID, raw metadata, scope, generated zero rows or summed totals.
	encoded, _ := json.Marshal(r)
	for _, forbidden := range []string{"1234", "rowCount", "metadata", "totals", "blockedReasons"} {
		if bytes.Contains(encoded, []byte(forbidden)) {
			t.Fatal("report exposed unsupported provider context or aggregate")
		}
	}
	pages[0].Body[0] = '!'
	e.Dimensions[0].Name = "changed"
	if r.Dimensions[0] != "syntheticGroup" || r.Rows[0].Dimensions[0] != "group A" {
		t.Fatal("report aliases input storage")
	}
}

func TestEmptyAndZeroObservations(t *testing.T) {
	for _, p := range []Page{
		fixture(0, 0),
		replace(fixture(0, 0), `"rowCount":0,`, ""),
		replace(replace(fixture(0, 0), `"rowCount":0,`, ""), `,"rows":[]`, ""),
	} {
		r, err := NormalizeIntegerReport(expectation(), []Page{p})
		if err != nil || r.Rows == nil || len(r.Rows) != 0 {
			t.Fatal("explicit empty/protobuf default observation differs")
		}
	}
	p := replace(fixture(0, 1, "measured group"), "9007199254740993", "0")
	r, err := NormalizeIntegerReport(expectation(), []Page{p})
	if err != nil || r.Rows[0].Metrics[0] != "0" || len(r.Rows) != 1 {
		t.Fatal("actual measured zero was not preserved")
	}
	// Explicit unrestrictive protobuf defaults are allowed, never null.
	p = replace(p, `"timeZone":"America/New_York"`, `"timeZone":"America/New_York","dataLossFromOtherRow":false,"subjectToThresholding":false,"schemaRestrictionResponse":{"activeMetricRestrictions":[]},"samplingMetadatas":[],"dataTruncationReasons":[],"emptyReason":"","currencyCode":"USD"`)
	p = replace(p, `"kind":`, `"totals":[],"maximums":[],"minimums":[],"kind":`)
	if _, err := NormalizeIntegerReport(expectation(), []Page{p}); err != nil {
		t.Fatal("supported empty quality/aggregate defaults rejected")
	}
}

func TestSchemaAndQualityRejection(t *testing.T) {
	p := fixture(0, 1, "group A")
	mutation := func(before, after string) []Page { return []Page{replace(p, before, after)} }
	cases := map[string][]Page{
		"missing headers":       mutation(`"dimensionHeaders":`, `"ignored":`),
		"wrong header":          mutation("syntheticCount", "otherMetric"),
		"wrong type":            mutation("TYPE_INTEGER", "TYPE_FLOAT"),
		"integer enum":          mutation(`"TYPE_INTEGER"`, `1`),
		"wrong kind":            mutation("analyticsData#runReport", "analyticsData#runPivotReport"),
		"timezone changed":      mutation("America/New_York", "UTC"),
		"missing timezone":      mutation("timeZone", "unused"),
		"missing metadata":      mutation(`"metadata":`, `"unknown":`),
		"case alias":            mutation("metricValues", "MetricValues"),
		"duplicate escaped":     mutation(`"rowCount":1`, `"rowCount":1,"row\u0043ount":1`),
		"duplicate nested":      mutation(`"value":"group A"`, `"value":"group A","value":"secret marker"`),
		"unknown row":           mutation(`"dimensionValues":`, `"private":"secret marker","dimensionValues":`),
		"unknown top":           mutation(`"kind":`, `"private":"secret marker","kind":`),
		"wrong dimension width": mutation(`"dimensionValues":[{"value":"group A"}]`, `"dimensionValues":[]`),
		"missing value":         mutation(`{"value":"group A"}`, `{}`),
		"value null":            mutation(`"value":"group A"`, `"value":null`),
		"numeric count":         mutation(`"9007199254740993"`, `9007199254740993`),
		"negative count":        mutation("9007199254740993", "-1"),
		"float count":           mutation("9007199254740993", "1.0"),
		"exponent count":        mutation("9007199254740993", "1e3"),
		"leading zero":          mutation("9007199254740993", "01"),
		"count overflow":        mutation("9007199254740993", "1000000000000000000"),
		"reserved aggregate":    mutation("group A", "RESERVED_TOTAL"),
		"control dimension":     mutation("group A", `group\u0000A`),
		"invalid surrogate":     mutation("group A", `\ud800`),
		"null rows":             mutation(`"rows":[{"dimensionValues":[{"value":"group A"}],"metricValues":[{"value":"9007199254740993"}]}]`, `"rows":null`),
		"null total":            mutation(`"rowCount":1`, `"rowCount":null`),
		"quoted total":          mutation(`"rowCount":1`, `"rowCount":"1"`),
		"large total":           mutation(`"rowCount":1`, `"rowCount":1001`),
		"negative total":        mutation(`"rowCount":1`, `"rowCount":-1`),
		"trailing document":     {{Offset: 0, Body: append(append([]byte{}, p.Body...), []byte(`{}`)...)}},
		"invalid UTF8":          {{Offset: 0, Body: append(append([]byte{}, p.Body...), 0xff)}},
		"oversize":              {{Offset: 0, Body: bytes.Repeat([]byte(" "), maxPageBytes+1)}},
	}
	for _, flag := range []string{
		`"dataLossFromOtherRow":true`, `"subjectToThresholding":true`, `"subjectToThresholding":null`,
		`"samplingMetadatas":[{"samplesReadCount":"1","samplingSpaceSize":"10"}]`,
		`"schemaRestrictionResponse":{"activeMetricRestrictions":[{"metricName":"syntheticCount"}]}`,
		`"dataTruncationReasons":[{"dataTruncationMessage":"private provider detail"}]`,
		`"emptyReason":"private provider detail"`, `"samplingMetadatas":null`,
		`"schemaRestrictionResponse":null`, `"unknownQuality":false`, `"timeZone":"UTC"`,
	} {
		cases[flag] = mutation(`"timeZone":"America/New_York"`, `"timeZone":"America/New_York",`+flag)
	}
	for label, pages := range cases {
		t.Run(label, func(t *testing.T) { unavailable(t, expectation(), pages) })
	}
}

func TestCompletePaginationRequired(t *testing.T) {
	a, b := fixture(0, 3, "A", "B"), fixture(2, 3, "C")
	cases := map[string][]Page{
		"no pages": nil, "incomplete": {a}, "duplicate tuple": {a, fixture(2, 3, "A")},
		"wrong offset": {a, fixture(1, 3, "C")}, "negative offset": {fixture(-1, 1, "A")},
		"changed total": {a, fixture(2, 4, "C", "D")}, "extra page": {a, b, fixture(3, 3)},
		"short first":    {fixture(0, 3, "A"), fixture(1, 3, "B", "C")},
		"too many pages": {a, b, b, b, b, b}, "extra rows": {fixture(0, 1, "A", "B")},
		"duplicate within page": {fixture(0, 2, "A", "A")},
		"late restriction":      {a, replace(b, `"timeZone":"America/New_York"`, `"timeZone":"America/New_York","subjectToThresholding":true`)},
	}
	for label, pages := range cases {
		t.Run(label, func(t *testing.T) { unavailable(t, expectation(), pages) })
	}
}

func TestVerifiedExpectationRequired(t *testing.T) {
	cases := map[string]func(*Expectation){
		"client":                 func(e *Expectation) { e.ClientID = "private client marker" },
		"connection":             func(e *Expectation) { e.ConnectionID = "00000000-0000-0000-0000-000000000000" },
		"property":               func(e *Expectation) { e.PropertyID = "properties/1234" },
		"timezone":               func(e *Expectation) { e.Timezone = "Local" },
		"invalid timezone":       func(e *Expectation) { e.Timezone = "Missing/Zone" },
		"invalid date":           func(e *Expectation) { e.Since = "2026-02-30" },
		"reverse period":         func(e *Expectation) { e.Until = "2026-03-06" },
		"too long period":        func(e *Expectation) { e.Until = "2026-04-07" },
		"bad limit":              func(e *Expectation) { e.Limit = 0 },
		"large limit":            func(e *Expectation) { e.Limit = 251 },
		"no dimensions":          func(e *Expectation) { e.Dimensions = nil },
		"duplicate dimension":    func(e *Expectation) { e.Dimensions = append(e.Dimensions, e.Dimensions[0]) },
		"custom dimension":       func(e *Expectation) { e.Dimensions[0].CustomDefinition = true },
		"dimension incompatible": func(e *Expectation) { e.Dimensions[0].Compatibility = "INCOMPATIBLE" },
		"no metrics":             func(e *Expectation) { e.Metrics = nil },
		"metric type":            func(e *Expectation) { e.Metrics[0].Type = "TYPE_CURRENCY" },
		"blocked metric":         func(e *Expectation) { e.Metrics[0].BlockedReasons = []string{"NO_REVENUE_METRICS"} },
		"metric incompatible":    func(e *Expectation) { e.Metrics[0].Compatibility = "COMPATIBILITY_UNSPECIFIED" },
		"expression":             func(e *Expectation) { e.Metrics[0].Expression = "syntheticCount*2" },
		"custom metric":          func(e *Expectation) { e.Metrics[0].CustomDefinition = true },
		"invalid name":           func(e *Expectation) { e.Metrics[0].Name = "customEvent:private" },
	}
	for label, mutate := range cases {
		t.Run(label, func(t *testing.T) {
			e := expectation()
			mutate(&e)
			unavailable(t, e, []Page{fixture(0, 1, "A")})
		})
	}
	// Inclusive 31 calendar days remains valid across DST, without UTC shifts.
	e := expectation()
	e.Until = "2026-04-06"
	if _, err := NormalizeIntegerReport(e, []Page{fixture(0, 1, "A")}); err != nil {
		t.Fatal("supported inclusive 31-day period rejected")
	}
}

func TestPageAndValueBounds(t *testing.T) {
	e := expectation()
	e.Limit = 250
	pages := make([]Page, 4)
	for page := range pages {
		labels := make([]string, 250)
		for row := range labels {
			labels[row] = fmt.Sprintf("synthetic group %04d", page*250+row)
		}
		pages[page] = fixture(page*250, 1000, labels...)
	}
	r, err := NormalizeIntegerReport(e, pages)
	if err != nil || len(r.Rows) != 1000 || r.Rows[999].Dimensions[0] != "synthetic group 0999" {
		t.Fatal("complete maximum bounded page sequence differs")
	}
	for _, length := range []int{0, 1024} {
		if _, err := NormalizeIntegerReport(expectation(), []Page{fixture(0, 1, strings.Repeat("x", length))}); err != nil {
			t.Fatal("supported ordinary dimension text boundary rejected")
		}
	}
	unavailable(t, expectation(), []Page{fixture(0, 1, strings.Repeat("x", 1025))})
	var pretty bytes.Buffer
	if json.Indent(&pretty, fixture(0, 1, "group").Body, "", "  ") != nil {
		t.Fatal("synthetic formatting failed")
	}
	if _, err := NormalizeIntegerReport(expectation(), []Page{{Body: pretty.Bytes()}}); err != nil {
		t.Fatal("ordinary JSON whitespace rejected")
	}
}

func TestColumnOrderAndDimensionTupleFraming(t *testing.T) {
	e := expectation()
	e.Dimensions = append(e.Dimensions, Dimension{Name: "syntheticSubgroup", Compatibility: "COMPATIBLE"})
	e.Metrics = append(e.Metrics, Metric{Name: "syntheticUniqueCount", Type: "TYPE_INTEGER", Compatibility: "COMPATIBLE"})
	var p map[string]any
	if json.Unmarshal(fixture(0, 2, "unused A", "unused B").Body, &p) != nil {
		t.Fatal("synthetic document unavailable")
	}
	p["dimensionHeaders"] = []any{map[string]any{"name": "syntheticGroup"}, map[string]any{"name": "syntheticSubgroup"}}
	p["metricHeaders"] = []any{map[string]any{"name": "syntheticCount", "type": "TYPE_INTEGER"}, map[string]any{"name": "syntheticUniqueCount", "type": "TYPE_INTEGER"}}
	p["rows"] = []any{
		map[string]any{"dimensionValues": []any{map[string]any{"value": "A|B"}, map[string]any{"value": "C"}}, "metricValues": []any{map[string]any{"value": "8"}, map[string]any{"value": "3"}}},
		map[string]any{"dimensionValues": []any{map[string]any{"value": "A"}, map[string]any{"value": "B|C"}}, "metricValues": []any{map[string]any{"value": "4"}, map[string]any{"value": "2"}}},
	}
	body, _ := json.Marshal(p)
	r, err := NormalizeIntegerReport(e, []Page{{Body: body}})
	if err != nil || len(r.Rows) != 2 || !reflect.DeepEqual(r.Rows[0].Metrics, []string{"8", "3"}) || !reflect.DeepEqual(r.Rows[1].Dimensions, []string{"A", "B|C"}) {
		t.Fatal("tuple framing or ordered nonsummed columns differ")
	}
	unavailable(t, e, []Page{replace(Page{Body: body}, `"name":"syntheticUniqueCount"`, `"name":"syntheticCount"`)})
	// Metadata order must match headers; changing the trusted requested order fails.
	e.Metrics[0], e.Metrics[1] = e.Metrics[1], e.Metrics[0]
	unavailable(t, e, []Page{{Body: body}})
}

func FuzzIntegerReportAtomicFailure(f *testing.F) {
	f.Add(fixture(0, 1, "synthetic group").Body)
	f.Add(fixture(0, 0).Body)
	f.Add([]byte(`{"private":"synthetic secret"}`))
	f.Fuzz(func(t *testing.T, body []byte) {
		r, err := NormalizeIntegerReport(expectation(), []Page{{Offset: 0, Body: body}})
		if err != nil && (err != ErrUnavailable || !reflect.DeepEqual(r, Report{})) {
			t.Fatal("failure leaked detail or partial result")
		}
	})
}
