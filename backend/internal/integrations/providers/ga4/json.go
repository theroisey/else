package ga4

import (
	"bytes"
	"encoding/json"
	"io"
)

// Provider objects use exact spellings and reject duplicate decoded names.
// This is private to this contract, with no general JSON framework or callers.
func object(raw []byte, allowed ...string) (map[string]json.RawMessage, bool) {
	d := json.NewDecoder(bytes.NewReader(raw))
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return nil, false
	}
	result := map[string]json.RawMessage{}
	for d.More() {
		token, err := d.Token()
		key, ok := token.(string)
		if err != nil || !ok || result[key] != nil {
			return nil, false
		}
		known := false
		for _, candidate := range allowed {
			known = known || key == candidate
		}
		if !known {
			return nil, false
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, false
		}
		result[key] = value
	}
	if token, err := d.Token(); err != nil || token != json.Delim('}') {
		return nil, false
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, false
	}
	return result, true
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
