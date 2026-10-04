// Package jsonvalue shares the existing strict provider-object boundary.
package jsonvalue

import (
	"bytes"
	"encoding/json"
	"io"
	"unicode/utf8"
)

// Object rejects duplicate decoded names, case aliases, unknown fields and
// trailing JSON. It returns no provider diagnostics to callers.
func Object(raw []byte, allowed ...string) (map[string]json.RawMessage, bool) {
	if !utf8.Valid(raw) {
		return nil, false
	}
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
