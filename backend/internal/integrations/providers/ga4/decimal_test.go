package ga4

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestExactObservedAttributionDecimals(t *testing.T) {
	for raw, expected := range map[string]string{"0": "0", "0.000": "0", "1.50": "1.5", "1.3333333333333333": "1.3333333333333333", "9.007199254740993e15": "9007199254740993", "1e-09": "0.000000001", "1E+02": "100", "0.000000000000000001": "0.000000000000000001", "999999999999999999": "999999999999999999"} {
		actual, ok := exactDecimal(raw)
		if !ok || actual != expected {
			t.Fatalf("exact decimal differs for %q: %q", raw, actual)
		}
	}
	for _, raw := range []string{"", "-0", "-1", "NaN", "Infinity", ".1", "1.", "01", "1e", "e1", "1ee1", "1e19", "1e-19", "1e+99", "1e1e1", "1.0e+100", "1000000000000000000", "0.0000000000000000001", "1 0", "1\n", "1e1\n", strings.Repeat("0", 65)} {
		if value, ok := exactDecimal(raw); ok || value != "" {
			t.Fatalf("unsupported decimal accepted: %q", raw)
		}
	}
}

func TestPeriodTotalAndMixedMetricsStayExactWithoutInventedUserSums(t *testing.T) {
	e := expectation()
	e.Dimensions = nil
	e.Metrics = []Metric{{Name: "activeUsers", Type: "TYPE_INTEGER", Compatibility: "COMPATIBLE"}, {Name: "keyEvents", Type: "TYPE_FLOAT", Compatibility: "COMPATIBLE"}}
	body := map[string]any{"kind": "analyticsData#runReport", "metadata": map[string]any{"timeZone": e.Timezone}, "metricHeaders": []map[string]string{{"name": "activeUsers", "type": "TYPE_INTEGER"}, {"name": "keyEvents", "type": "TYPE_FLOAT"}}, "rowCount": 1, "rows": []map[string]any{{"metricValues": []map[string]string{{"value": "9007199254740993"}, {"value": "1.3333333333333333"}}}}}
	raw, _ := json.Marshal(body)
	page := Page{Body: raw}
	result, err := NormalizeMetricReport(e, []Page{page})
	if err != nil || result.Dimensions == nil || len(result.Dimensions) != 0 || len(result.Rows) != 1 || result.Rows[0].Dimensions == nil || !reflect.DeepEqual(result.Rows[0].Metrics, []string{"9007199254740993", "1.3333333333333333"}) {
		t.Fatal("exact dimensionless observations changed")
	}
	if result, err := NormalizeIntegerReport(e, []Page{page}); err != ErrUnavailable || len(result.Rows) != 0 {
		t.Fatal("legacy integer contract broadened")
	}
	e.Metrics[1].BlockedReasons = []string{"NO_REVENUE_METRICS"}
	if result, err := NormalizeMetricReport(e, []Page{page}); err != ErrUnavailable || len(result.Rows) != 0 {
		t.Fatal("blocked metric exposed as measurement")
	}
	e.Metrics[1].BlockedReasons = nil
	page.Body = []byte(strings.Replace(string(raw), "TYPE_FLOAT", "TYPE_INTEGER", 1))
	if result, err := NormalizeMetricReport(e, []Page{page}); err != ErrUnavailable || len(result.Rows) != 0 {
		t.Fatal("mismatched observed type accepted")
	}
}
