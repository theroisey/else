package credentials

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

func fixtureDocument() string {
	return fmt.Sprintf(`{"active_key_id":"fixture-v2","keys":[{"id":"fixture-v1","key_base64":%q},{"id":"fixture-v2","key_base64":%q}]}`,
		base64.StdEncoding.EncodeToString(fixtureKey(1)), base64.StdEncoding.EncodeToString(fixtureKey(2)))
}

func TestReadKeyringRetainsOldKeysAndUsesActiveKey(t *testing.T) {
	r, err := ReadKeyring(strings.NewReader(fixtureDocument()))
	if err != nil {
		t.Fatal("valid document rejected")
	}
	old := fixtureRing(t, "fixture-v1", map[string][]byte{"fixture-v1": fixtureKey(1)})
	e := fixtureSeal(t, old, []byte("synthetic-token"))
	got, err := r.Open(fixtureBinding, e)
	if err != nil || string(got) != "synthetic-token" {
		t.Fatal("retained key unavailable")
	}
	clear(got)
	current := fixtureRing(t, "fixture-v2", map[string][]byte{"fixture-v2": fixtureKey(2)})
	e = fixtureSeal(t, r, []byte("synthetic-token"))
	got, err = current.Open(fixtureBinding, e)
	if err != nil || string(got) != "synthetic-token" {
		t.Fatal("active key not used")
	}
	clear(got)
	// The largest permitted label and eight retained keys stay supported.
	keys := map[string][]byte{}
	entries := []map[string]string{}
	for i := 0; i < MaxKeys; i++ {
		id := strings.Repeat("a", 63) + fmt.Sprint(i)
		keys[id] = fixtureKey(byte(i + 1))
		entries = append(entries, map[string]string{"id": id, "key_base64": base64.StdEncoding.EncodeToString(keys[id])})
	}
	document, _ := json.Marshal(map[string]any{"active_key_id": strings.Repeat("a", 63) + "0", "keys": entries})
	r, err = ReadKeyring(bytes.NewReader(document))
	if err != nil {
		t.Fatal("bounded maximum ring rejected")
	}
	e = fixtureSeal(t, r, bytes.Repeat([]byte{1}, MaxPlaintextBytes))
	if len(e.raw()) != MaxEnvelopeBytes {
		t.Fatal("wire bound mismatch")
	}
	if _, err := ParseEnvelope(e.Binary()); err != nil {
		t.Fatal("maximum envelope rejected")
	}
}

func TestReadKeyringRejectsAmbiguousOrInvalidDocuments(t *testing.T) {
	valid := fixtureDocument()
	key := base64.StdEncoding.EncodeToString(fixtureKey(1))
	tooMany := []map[string]string{}
	for i := 0; i < MaxKeys+1; i++ {
		tooMany = append(tooMany, map[string]string{"id": fmt.Sprintf("fixture-%d", i), "key_base64": base64.StdEncoding.EncodeToString(fixtureKey(byte(i + 1)))})
	}
	oversubscribed, _ := json.Marshal(map[string]any{"active_key_id": "fixture-0", "keys": tooMany})
	for name, document := range map[string]string{
		"empty": "", "null": "null", "array": "[]", "missing": "{}", "empty-keys": `{"active_key_id":"fixture-v1","keys":[]}`,
		"trailing": valid + ` {}`, "syntax": valid[:len(valid)-1],
		"duplicate-top":        strings.Replace(valid, `"active_key_id":"fixture-v2"`, `"active_key_id":"fixture-v1","active_key_id":"fixture-v2"`, 1),
		"escaped-duplicate":    strings.Replace(valid, `"active_key_id":"fixture-v2"`, `"active_key_id":"fixture-v1","active_\u006bey_id":"fixture-v2"`, 1),
		"duplicate-key-field":  strings.Replace(valid, `"id":"fixture-v1"`, `"id":"bad","id":"fixture-v1"`, 1),
		"duplicate-case-alias": strings.Replace(valid, `"active_key_id":"fixture-v2"`, `"active_key_id":"fixture-v1","ACTIVE_KEY_ID":"fixture-v2"`, 1),
		"uppercase-field":      strings.Replace(valid, `"keys"`, `"KEYS"`, 1),
		"unknown-top":          strings.Replace(valid, `"keys":`, `"unexpected":"synthetic-secret","keys":`, 1),
		"unknown-entry":        strings.Replace(valid, `"id":"fixture-v1"`, `"unexpected":"synthetic-secret","id":"fixture-v1"`, 1),
		"duplicate-id":         strings.Replace(valid, `"id":"fixture-v2"`, `"id":"fixture-v1"`, 1),
		"duplicate-material":   strings.Replace(valid, base64.StdEncoding.EncodeToString(fixtureKey(2)), key, 1),
		"missing-active":       strings.Replace(valid, `"fixture-v2"`, `"fixture-v3"`, 1),
		"zero-key":             fmt.Sprintf(`{"active_key_id":"fixture-v1","keys":[{"id":"fixture-v1","key_base64":%q}]}`, base64.StdEncoding.EncodeToString(make([]byte, 32))),
		"short-key":            strings.Replace(valid, key, base64.StdEncoding.EncodeToString(make([]byte, 31)), 1),
		"long-key":             strings.Replace(valid, key, base64.StdEncoding.EncodeToString(make([]byte, 33)), 1),
		"unpadded":             strings.Replace(valid, key, strings.TrimRight(key, "="), 1),
		"linebreak":            strings.Replace(valid, key, key[:20]+`\n`+key[20:], 1),
		"invalid-base64":       strings.Replace(valid, key, "synthetic-secret", 1),
		"unsafe-label":         strings.Replace(valid, `"id":"fixture-v1"`, `"id":"../secret"`, 1),
		"oversubscribed":       string(oversubscribed), "oversized": strings.Repeat(" ", MaxKeyringBytes+1),
		"deep": `{"keys":[[[[[[[[]]]]]]]]}`, "wrong-type": `{"active_key_id":123,"keys":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			r, err := ReadKeyring(strings.NewReader(document))
			if r != nil || err != ErrKeyring {
				t.Fatal("invalid/ambiguous document accepted")
			}
			if strings.Contains(err.Error(), "synthetic-secret") {
				t.Fatal("parser leaked input")
			}
		})
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) {
	return 0, errors.New("synthetic-secret reader failure")
}

type countedReader struct{ n int }

func (r *countedReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = ' '
	}
	r.n += len(p)
	return len(p), nil
}

func TestReadKeyringBoundsReadsAndDiscardsReaderErrors(t *testing.T) {
	for _, reader := range []io.Reader{nil, failingReader{}} {
		if r, err := ReadKeyring(reader); r != nil || err != ErrKeyring {
			t.Fatal("unsafe reader error")
		}
	}
	reader := &countedReader{}
	if r, err := ReadKeyring(reader); r != nil || err != ErrKeyring {
		t.Fatal("unbounded document accepted")
	}
	if reader.n != MaxKeyringBytes+1 {
		t.Fatal("reader exceeded byte budget")
	}
	// Whitespace padding at the exact document budget is valid, one byte more is not.
	document := fixtureDocument()
	document += strings.Repeat(" ", MaxKeyringBytes-len(document))
	if _, err := ReadKeyring(strings.NewReader(document)); err != nil {
		t.Fatal("exact document budget rejected")
	}
	if r, err := ReadKeyring(strings.NewReader(document + " ")); r != nil || err != ErrKeyring {
		t.Fatal("document budget exceeded")
	}
}

func FuzzKeyringParserIsBoundedAndSafe(f *testing.F) {
	f.Add([]byte(fixtureDocument()))
	f.Add([]byte(`{"keys":null}`))
	f.Add([]byte{})
	f.Add([]byte(`{"keys":{},"keys":[]}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		r, err := ReadKeyring(bytes.NewReader(data))
		if err != nil {
			if r != nil || err != ErrKeyring {
				t.Fatal("unsafe parser failure")
			}
			return
		}
		if len(data) > MaxKeyringBytes {
			t.Fatal("oversized document accepted")
		}
		e, err := r.Seal(fixtureBinding, []byte("synthetic-token"))
		if err != nil {
			t.Fatal("accepted ring cannot seal")
		}
		got, err := r.Open(fixtureBinding, e)
		if err != nil || string(got) != "synthetic-token" {
			t.Fatal("accepted ring cannot open")
		}
		clear(got)
	})
}
