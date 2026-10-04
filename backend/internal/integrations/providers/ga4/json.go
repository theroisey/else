package ga4

import (
	"bytes"
	"encoding/json"
	"github.com/theroisey/else/backend/internal/integrations/providers/internal/jsonvalue"
)

// Keep this contract's private API while sharing the strict object boundary.
func object(raw []byte, allowed ...string) (map[string]json.RawMessage, bool) {
	return jsonvalue.Object(raw, allowed...)
}

func array(raw []byte, absent bool) ([]json.RawMessage, bool) {
	if raw == nil && absent {
		return nil, true
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, false
	}
	var values []json.RawMessage
	if json.Unmarshal(trimmed, &values) != nil {
		return nil, false
	}
	return values, true
}

func emptyArray(raw []byte) bool {
	values, ok := array(raw, true)
	return ok && len(values) == 0
}

func stringValue(raw []byte, result *string) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '"' && json.Unmarshal(trimmed, result) == nil
}

func exactString(raw []byte, expected string) bool {
	var s string
	return stringValue(raw, &s) && s == expected
}

func regexpInteger(raw []byte) bool {
	// rowCount is the int32 JSON number, unlike string metric values.
	return integer.Match(raw)
}

func validMetadata(raw []byte, timezone string) bool {
	m, ok := object(raw, "timeZone", "currencyCode", "emptyReason", "dataLossFromOtherRow", "subjectToThresholding", "schemaRestrictionResponse", "samplingMetadatas", "dataTruncationReasons")
	if !ok || !exactString(m["timeZone"], timezone) {
		return false
	}
	for _, key := range []string{"dataLossFromOtherRow", "subjectToThresholding"} {
		if value, exists := m[key]; exists && !bytes.Equal(value, []byte("false")) {
			return false
		}
	}
	if raw, exists := m["emptyReason"]; exists && !exactString(raw, "") {
		return false
	}
	if raw, exists := m["currencyCode"]; exists {
		var s string
		if !stringValue(raw, &s) || len(s) != 3 || s[0] < 'A' || s[0] > 'Z' || s[1] < 'A' || s[1] > 'Z' || s[2] < 'A' || s[2] > 'Z' {
			return false
		}
	}
	if !emptyArray(m["samplingMetadatas"]) || !emptyArray(m["dataTruncationReasons"]) {
		return false
	}
	if raw, exists := m["schemaRestrictionResponse"]; exists {
		r, ok := object(raw, "activeMetricRestrictions")
		if !ok || !emptyArray(r["activeMetricRestrictions"]) {
			return false
		}
	}
	return true
}
