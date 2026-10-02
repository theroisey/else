package credentials

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
)

// ReadKeyring reads a bounded secret document from a caller-owned reader. The
// caller must supply a protected secret-manager/mounted-file reader, never a
// request body or provider response. No environment or filesystem is inspected.
// Errors discard parser/I/O details because they may contain credential values.
func ReadKeyring(r io.Reader) (*Keyring, error) {
	if r == nil {
		return nil, ErrKeyring
	}
	data, err := io.ReadAll(io.LimitReader(r, MaxKeyringBytes+1))
	defer clear(data)
	if err != nil || len(data) == 0 || len(data) > MaxKeyringBytes || !uniqueFields(data) {
		return nil, ErrKeyring
	}
	var document struct {
		Active string `json:"active_key_id"`
		Keys   []struct {
			ID  string `json:"id"`
			Key string `json:"key_base64"`
		} `json:"keys"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&document) != nil || len(document.Keys) == 0 || len(document.Keys) > MaxKeys {
		return nil, ErrKeyring
	}
	keys := make(map[string][]byte, len(document.Keys))
	defer func() {
		for _, key := range keys {
			clear(key)
		}
	}()
	for _, entry := range document.Keys {
		if !label.MatchString(entry.ID) || keys[entry.ID] != nil {
			return nil, ErrKeyring
		}
		key, err := base64.StdEncoding.Strict().DecodeString(entry.Key)
		if err != nil || len(key) != 32 || base64.StdEncoding.EncodeToString(key) != entry.Key {
			clear(key)
			return nil, ErrKeyring
		}
		keys[entry.ID] = key
	}
	return New(document.Active, keys)
}

// encoding/json otherwise accepts duplicate fields with last-value-wins. Reject
// them at every object level, plus trailing values and excessive nesting.
func uniqueFields(data []byte) bool {
	d := json.NewDecoder(bytes.NewReader(data))
	var value func(int) bool
	value = func(depth int) bool {
		if depth > 4 {
			return false
		}
		token, err := d.Token()
		if err != nil {
			return false
		}
		delim, container := token.(json.Delim)
		if !container {
			return true
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				name, ok := key.(string)
				if err != nil || !ok || seen[name] {
					return false
				}
				// Match field spellings exactly; encoding/json's case-insensitive
				// struct matching would otherwise permit duplicate aliases.
				if name != "active_key_id" && name != "keys" && name != "id" && name != "key_base64" {
					return false
				}
				seen[name] = true
				if !value(depth + 1) {
					return false
				}
			}
			end, err := d.Token()
			return err == nil && end == json.Delim('}')
		case '[':
			for d.More() {
				if !value(depth + 1) {
					return false
				}
			}
			end, err := d.Token()
			return err == nil && end == json.Delim(']')
		default:
			return false
		}
	}
	if !value(0) {
		return false
	}
	_, err := d.Token()
	return err == io.EOF
}
