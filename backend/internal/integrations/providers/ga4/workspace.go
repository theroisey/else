package ga4

import (
	"encoding/json"
	"reflect"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ValidWorkspace validates a normalized stored DTO's shape, bounds and exact
// client/connection/period. It does not infer fresh metadata, account access,
// quality or ownership from a DTO; those must precede publication through Fetch.
// PropertyID deliberately is not needed here: it is excluded from public DTOs.
func ValidWorkspace(w Workspace, request Request) bool {
	if len(w.Definitions) != 4 {
		return false
	}
	metrics := make([]Metric, 0, 4)
	for i, definition := range w.Definitions {
		if definition.Name != metricNames()[i] || (definition.Type != "TYPE_INTEGER" && definition.Type != "TYPE_FLOAT") || (i < 3 && definition.Type != "TYPE_INTEGER") {
			return false
		}
		label, _ := json.Marshal(definition.DisplayName)
		description, _ := json.Marshal(definition.Description)
		if _, ok := metadataText(label, 256, false); !ok {
			return false
		}
		if _, ok := metadataText(description, 4096, true); !ok {
			return false
		}
		metrics = append(metrics, Metric{Name: definition.Name, Type: definition.Type, Compatibility: "COMPATIBLE"})
	}
	for _, template := range []struct {
		report     Report
		dimensions []string
	}{{w.Summary, []string{}}, {w.Daily, []string{"date"}}, {w.Acquisition, []string{"date", "sessionDefaultChannelGroup"}}, {w.Devices, []string{"date", "deviceCategory"}}, {w.Landing, []string{"landingPage"}}} {
		r := template.report
		if r.ClientID != request.ClientID || r.ConnectionID != request.ConnectionID || r.Since != request.Since || r.Until != request.Until || r.Timezone != w.Summary.Timezone || r.APIVersion != APIVersion || !reflect.DeepEqual(r.Dimensions, template.dimensions) || !reflect.DeepEqual(r.Metrics, metricNames()) || r.Rows == nil || len(r.Rows) > 1000 || (len(template.dimensions) == 0 && len(r.Rows) > 1) {
			return false
		}
		e := Expectation{ClientID: r.ClientID, ConnectionID: r.ConnectionID, PropertyID: "1", Since: r.Since, Until: r.Until, Timezone: r.Timezone, Limit: reportLimit, Metrics: metrics}
		for _, name := range template.dimensions {
			e.Dimensions = append(e.Dimensions, Dimension{Name: name, Compatibility: "COMPATIBLE"})
		}
		if !validExpectationTypes(e, true) {
			return false
		}
		for _, row := range r.Rows {
			if row.Dimensions == nil || len(row.Dimensions) != len(template.dimensions) || len(row.Metrics) != 4 {
				return false
			}
			for _, value := range row.Dimensions {
				if len(value) > 1024 || strings.HasPrefix(value, "RESERVED_") || !utf8.ValidString(value) {
					return false
				}
				for _, char := range value {
					if unicode.IsControl(char) || char == utf8.RuneError {
						return false
					}
				}
			}
			for i, value := range row.Metrics {
				if metrics[i].Type == "TYPE_INTEGER" {
					if !integer.MatchString(value) {
						return false
					}
				} else if normalized, ok := exactDecimal(value); !ok || normalized != value {
					return false
				}
			}
		}
		if !validTemplateRows(r) {
			return false
		}
	}
	return true
}
