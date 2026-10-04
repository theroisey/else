package ga4

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestCompatibilityRejectsMissingBlockedCustomOrChangedMetricContract(t *testing.T) {
	raw := compatibilityFixture()
	for label, mutate := range map[string]func([]byte) []byte{
		"missing selected metric": func(raw []byte) []byte {
			return []byte(strings.Replace(string(raw), `"apiName":"activeUsers"`, `"apiName":"otherUsers"`, 1))
		},
		"missing selected dimension": func(raw []byte) []byte {
			return []byte(strings.Replace(string(raw), `"apiName":"date"`, `"apiName":"otherDate"`, 1))
		},
		"blocked": func(raw []byte) []byte {
			return []byte(strings.Replace(string(raw), `"apiName":"activeUsers"`, `"apiName":"activeUsers","blockedReasons":["NO_REVENUE_METRICS"]`, 1))
		},
		"null restriction": func(raw []byte) []byte {
			return []byte(strings.Replace(string(raw), `"apiName":"activeUsers"`, `"apiName":"activeUsers","blockedReasons":null`, 1))
		},
		"custom": func(raw []byte) []byte {
			return []byte(strings.Replace(string(raw), `"apiName":"activeUsers"`, `"apiName":"activeUsers","customDefinition":true`, 1))
		},
		"expression": func(raw []byte) []byte {
			return []byte(strings.Replace(string(raw), `"apiName":"activeUsers"`, `"apiName":"activeUsers","expression":"sessions/activeUsers"`, 1))
		},
		"duplicate decoded field": func(raw []byte) []byte {
			return []byte(strings.Replace(string(raw), `"apiName":"activeUsers"`, `"apiName":"activeUsers","api\u004eame":"activeUsers"`, 1))
		},
		"duplicate column": func(raw []byte) []byte {
			return []byte(strings.Replace(string(raw), `"apiName":"unusedMetric"`, `"apiName":"activeUsers"`, 1))
		},
		"unsupported fractional count": func(raw []byte) []byte {
			return []byte(strings.Replace(string(raw), `"apiName":"activeUsers","description"`, `"apiName":"activeUsers","type":"TYPE_FLOAT","description"`, 1))
		},
		"incompatible": func(raw []byte) []byte { return []byte(strings.ReplaceAll(string(raw), "COMPATIBLE", "INCOMPATIBLE")) },
		"private metadata field": func(raw []byte) []byte {
			return []byte(strings.Replace(string(raw), `"apiName":"activeUsers"`, `"apiName":"activeUsers","email":"private@example.com"`, 1))
		},
		"oversized": func(raw []byte) []byte { return append(raw, []byte(strings.Repeat(" ", 256<<10))...) },
		"unknown root": func(raw []byte) []byte {
			return []byte(strings.Replace(string(raw), `"metricCompatibilities":`, `"MetricCompatibilities":`, 1))
		},
		"missing definitions": func(raw []byte) []byte { return []byte(strings.ReplaceAll(string(raw), "description", "unsupported")) },
	} {
		t.Run(label, func(t *testing.T) {
			changed := mutate(raw)
			if reflect.DeepEqual(changed, raw) {
				t.Fatal("adversarial mutation did not apply")
			}
			dimensions, metrics, definitions, err := parseCompatibility(changed, []string{"date"})
			if err != ErrUnavailable || dimensions != nil || metrics != nil || definitions != nil {
				t.Fatal("unsafe metadata exposed partial definitions")
			}
		})
	}
}

func TestCompatibilityProjectedCatalogHasFixedBudgetAndSelectedOrdering(t *testing.T) {
	var catalog map[string][]map[string]any
	if json.Unmarshal(compatibilityFixture(), &catalog) != nil {
		t.Fatal("fixture unavailable")
	}
	for i := 0; i < 500; i++ {
		catalog["metricCompatibilities"] = append(catalog["metricCompatibilities"], map[string]any{"compatibility": "COMPATIBLE", "metricMetadata": map[string]any{"apiName": "customUnused" + strings.Repeat("x", 100) + string(rune('a'+i/26)) + string(rune('a'+i%26)), "description": "Unused documentation"}})
	}
	raw, _ := json.Marshal(catalog)
	if len(raw) <= 64<<10 || len(raw) > 256<<10 {
		t.Fatal("catalog fixture does not exercise metadata budget")
	}
	dimensions, metrics, definitions, err := parseCompatibility(raw, []string{"date", "deviceCategory"})
	if err != nil || len(dimensions) != 2 || dimensions[0].Name != "date" || dimensions[1].Name != "deviceCategory" || len(metrics) != 4 || len(definitions) != 4 || metrics[0].Name != "activeUsers" || metrics[3].Type != "TYPE_FLOAT" {
		t.Fatal("projected catalog selection changed")
	}
	for i := 0; i < 1600; i++ {
		catalog["dimensionCompatibilities"] = append(catalog["dimensionCompatibilities"], map[string]any{"compatibility": "COMPATIBLE", "dimensionMetadata": map[string]any{"apiName": "synthetic"}})
	}
	raw, _ = json.Marshal(catalog)
	if _, _, _, err := parseCompatibility(raw, []string{"date"}); err != ErrUnavailable {
		t.Fatal("duplicate/unbounded catalog accepted")
	}
}

func FuzzCompatibilityRemainsAtomic(f *testing.F) {
	f.Add(compatibilityFixture())
	f.Add([]byte(`{"dimensionCompatibilities":[],"metricCompatibilities":[]}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		dimensions, metrics, definitions, err := parseCompatibility(raw, []string{"date"})
		if err != nil && (err != ErrUnavailable || dimensions != nil || metrics != nil || definitions != nil) {
			t.Fatal("private diagnostic or partial metadata escaped")
		}
		if err == nil && (len(dimensions) != 1 || len(metrics) != 4 || len(definitions) != 4) {
			t.Fatal("successful metadata is incomplete")
		}
	})
}
