package ga4

import (
	"bytes"
	"encoding/json"

	"github.com/theroisey/else/backend/internal/integrations/providerhttp"
)

// CheckCompatibility returns a catalog, not just the requested columns. Parse
// its bounded projected structure, select exact names and discard everything
// else. Absence of an unblocked compatible requested column is unavailable.
func parseCompatibility(raw []byte, dimensionNames []string) ([]Dimension, []Metric, []Definition, error) {
	if len(raw) == 0 || len(raw) > providerhttp.MaxMetadataResponseBytes {
		return nil, nil, nil, ErrUnavailable
	}
	root, ok := object(raw, "dimensionCompatibilities", "metricCompatibilities")
	if !ok {
		return nil, nil, nil, ErrUnavailable
	}
	selectedDimensions := make(map[string]Dimension)
	selectedMetrics := make(map[string]Metric)
	selectedDefinitions := make(map[string]Definition)
	for _, catalog := range []struct {
		key, metadata string
		metric        bool
	}{
		{"dimensionCompatibilities", "dimensionMetadata", false},
		{"metricCompatibilities", "metricMetadata", true},
	} {
		entries, ok := array(root[catalog.key], !catalog.metric && len(dimensionNames) == 0)
		if !ok || len(entries) > 2048 {
			return nil, nil, nil, ErrUnavailable
		}
		seen := make(map[string]bool)
		for _, entry := range entries {
			wrapper, ok := object(entry, "compatibility", catalog.metadata)
			if !ok || len(wrapper) != 2 {
				return nil, nil, nil, ErrUnavailable
			}
			var fields map[string]json.RawMessage
			if catalog.metric {
				fields, ok = object(wrapper[catalog.metadata], "apiName", "type", "blockedReasons", "customDefinition", "expression", "uiName", "description")
			} else {
				fields, ok = object(wrapper[catalog.metadata], "apiName", "customDefinition")
			}
			apiName, validName := metadataText(fields["apiName"], 256, false)
			if !ok || !validName || seen[apiName] {
				return nil, nil, nil, ErrUnavailable
			}
			seen[apiName] = true
			wanted := false
			names := dimensionNames
			if catalog.metric {
				names = metricNames()
			}
			for _, name := range names {
				wanted = wanted || apiName == name
			}
			if !wanted {
				continue
			}
			if !exactString(wrapper["compatibility"], "COMPATIBLE") || !defaultFalse(fields["customDefinition"]) {
				return nil, nil, nil, ErrUnavailable
			}
			if !catalog.metric {
				selectedDimensions[apiName] = Dimension{Name: apiName, Compatibility: "COMPATIBLE"}
				continue
			}
			var metricType string
			if !stringValue(fields["type"], &metricType) || (metricType != "TYPE_INTEGER" && metricType != "TYPE_FLOAT") || !emptyArray(fields["blockedReasons"]) {
				return nil, nil, nil, ErrUnavailable
			}
			// Only keyEvents may have fractional attribution. User/session/view
			// counts are integers; fail on a changed schema rather than relabel it.
			if apiName != "keyEvents" && metricType != "TYPE_INTEGER" {
				return nil, nil, nil, ErrUnavailable
			}
			if expression, present := fields["expression"]; present && !exactString(expression, "") {
				return nil, nil, nil, ErrUnavailable
			}
			label, labelOK := metadataText(fields["uiName"], 256, false)
			description, descriptionOK := metadataText(fields["description"], 4096, true)
			if !labelOK || !descriptionOK {
				return nil, nil, nil, ErrUnavailable
			}
			selectedMetrics[apiName] = Metric{Name: apiName, Type: metricType, Compatibility: "COMPATIBLE"}
			selectedDefinitions[apiName] = Definition{Name: apiName, Type: metricType, DisplayName: label, Description: description}
		}
	}
	var dimensions []Dimension
	var metrics []Metric
	var definitions []Definition
	for _, name := range dimensionNames {
		value, exists := selectedDimensions[name]
		if !exists {
			return nil, nil, nil, ErrUnavailable
		}
		dimensions = append(dimensions, value)
	}
	for _, name := range metricNames() {
		metric, exists := selectedMetrics[name]
		if !exists {
			return nil, nil, nil, ErrUnavailable
		}
		metrics = append(metrics, metric)
		definitions = append(definitions, selectedDefinitions[name])
	}
	return dimensions, metrics, definitions, nil
}

func defaultFalse(raw []byte) bool {
	return raw == nil || bytes.Equal(bytes.TrimSpace(raw), []byte("false"))
}
