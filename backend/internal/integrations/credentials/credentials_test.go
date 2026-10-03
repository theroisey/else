package credentials

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
)

var fixtureBinding = Binding{
	ClientID:     "10000000-0000-4000-8000-000000000001",
	ConnectionID: "20000000-0000-4000-8000-000000000002",
	Provider:     "fixture-provider", Purpose: "refresh-token",
}

// These fixed bytes are synthetic test material, never deployment keys/tokens.
func fixtureKey(n byte) []byte       { return bytes.Repeat([]byte{n}, 32) }
func unchecked(data []byte) Envelope { return Envelope{state: &envelopeState{data: data}} }
func fixtureRing(t *testing.T, active string, keys map[string][]byte) *Keyring {
	t.Helper()
	r, err := New(active, keys)
	if err != nil {
		t.Fatal("synthetic key ring rejected")
	}
	return r
}
func fixtureSeal(t *testing.T, r *Keyring, plaintext []byte) Envelope {
	t.Helper()
	e, err := r.Seal(fixtureBinding, plaintext)
	if err != nil {
		t.Fatal("synthetic secret rejected")
	}
	return e
}

func TestRoundTripAndIndependentGCM(t *testing.T) {
	key := fixtureKey(0x42)
	r := fixtureRing(t, "fixture-v1", map[string][]byte{"fixture-v1": key})
	for _, plaintext := range [][]byte{{0, 255, 1}, []byte("synthetic-token"), bytes.Repeat([]byte{0x61}, MaxPlaintextBytes)} {
		e := fixtureSeal(t, r, plaintext)
		got, err := r.Open(fixtureBinding, e)
		if err != nil || !bytes.Equal(got, plaintext) {
			t.Fatal("round trip failed")
		}
		clear(got)
		parsed, err := ParseEnvelope(e.Binary())
		if err != nil {
			t.Fatal("persisted envelope rejected")
		}
		got, err = r.Open(fixtureBinding, parsed)
		if err != nil || !bytes.Equal(got, plaintext) {
			t.Fatal("storage round trip failed")
		}
		clear(got)

		// Independently reconstruct the wire contract using ordinary GCM. This
		// checks the stored nonce/tag and AAD format beyond Seal/Open symmetry.
		wire := e.Binary()
		headerLen := 2 + int(wire[1])
		block, err := aes.NewCipher(key)
		if err != nil {
			t.Fatal(err)
		}
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			t.Fatal(err)
		}
		aad := append([]byte("roisey-else/integration-credential\x00"), wire[:headerLen]...)
		aad = append(aad, []byte("\x00"+fixtureBinding.ClientID+"\x00"+fixtureBinding.ConnectionID+"\x00fixture-provider\x00refresh-token")...)
		got, err = gcm.Open(nil, wire[headerLen:headerLen+12], wire[headerLen+12:], aad)
		if err != nil || !bytes.Equal(got, plaintext) {
			t.Fatal("wire contract mismatch")
		}
		clear(got)
	}
}

func TestBindingSubstitutionAndTampering(t *testing.T) {
	r := fixtureRing(t, "fixture-v1", map[string][]byte{"fixture-v1": fixtureKey(1), "fixture-v2": fixtureKey(2)})
	e := fixtureSeal(t, r, []byte("synthetic-token"))
	for name, mutate := range map[string]func(*Binding){
		"client":     func(b *Binding) { b.ClientID = "10000000-0000-4000-8000-000000000009" },
		"connection": func(b *Binding) { b.ConnectionID = "20000000-0000-4000-8000-000000000009" },
		"provider":   func(b *Binding) { b.Provider = "another-provider" },
		"purpose":    func(b *Binding) { b.Purpose = "access-token" },
	} {
		t.Run(name, func(t *testing.T) {
			binding := fixtureBinding
			mutate(&binding)
			got, err := r.Open(binding, e)
			if got != nil || err != ErrOpen {
				t.Fatal("substituted binding accepted")
			}
		})
	}
	// Every byte of version, key label, nonce, ciphertext and tag is protected.
	for i := range e.raw() {
		wire := e.Binary()
		wire[i] ^= 1
		got, err := r.Open(fixtureBinding, unchecked(wire))
		if got != nil || err != ErrOpen {
			t.Fatalf("modified byte %d accepted", i)
		}
	}
	// A syntactically valid retained-key label substitution also fails.
	wire := e.Binary()
	wire[2+len("fixture-v")] = '2'
	got, err := r.Open(fixtureBinding, unchecked(wire))
	if got != nil || err != ErrOpen {
		t.Fatal("retained key substitution accepted")
	}
	for _, wire := range [][]byte{nil, {1}, e.raw()[:len(e.raw())-1], append(e.Binary(), 0), make([]byte, MaxEnvelopeBytes+1)} {
		got, err := r.Open(fixtureBinding, unchecked(wire))
		if got != nil || err != ErrOpen {
			t.Fatal("malformed envelope accepted")
		}
	}
}

func TestRotationRequiresAuthenticOldEnvelope(t *testing.T) {
	old := fixtureRing(t, "fixture-v1", map[string][]byte{"fixture-v1": fixtureKey(1)})
	both := fixtureRing(t, "fixture-v2", map[string][]byte{"fixture-v1": fixtureKey(1), "fixture-v2": fixtureKey(2)})
	current := fixtureRing(t, "fixture-v2", map[string][]byte{"fixture-v2": fixtureKey(2)})
	wrong := fixtureRing(t, "fixture-v1", map[string][]byte{"fixture-v1": fixtureKey(3)})
	e := fixtureSeal(t, old, []byte("synthetic-token"))
	got, err := both.Open(fixtureBinding, e)
	if err != nil || string(got) != "synthetic-token" {
		t.Fatal("retained key cannot decrypt")
	}
	clear(got)
	for _, ring := range []*Keyring{current, wrong, nil, {}} {
		got, err := ring.Open(fixtureBinding, e)
		if got != nil || err != ErrOpen {
			t.Fatal("missing/wrong key accepted")
		}
		rotated, err := ring.Rewrap(fixtureBinding, e)
		if rotated.raw() != nil || err != ErrOpen {
			t.Fatal("missing/wrong key rewrap accepted")
		}
	}
	rotated, err := both.Rewrap(fixtureBinding, e)
	if err != nil || bytes.Equal(rotated.raw(), e.raw()) {
		t.Fatal("rotation failed")
	}
	if string(rotated.raw()[2:2+int(rotated.raw()[1])]) != "fixture-v2" {
		t.Fatal("inactive key used")
	}
	got, err = current.Open(fixtureBinding, rotated)
	if err != nil || string(got) != "synthetic-token" {
		t.Fatal("rotated secret cannot decrypt")
	}
	clear(got)
	if got, err := old.Open(fixtureBinding, rotated); got != nil || err != ErrOpen {
		t.Fatal("removed key decrypts")
	}
	bad := fixtureBinding
	bad.ClientID = "10000000-0000-4000-8000-000000000009"
	if rotated, err := both.Rewrap(bad, e); rotated.raw() != nil || err != ErrOpen {
		t.Fatal("cross-client rewrap accepted")
	}
	wire := e.Binary()
	wire[len(wire)-1] ^= 1
	if rotated, err := both.Rewrap(fixtureBinding, unchecked(wire)); rotated.raw() != nil || err != ErrOpen {
		t.Fatal("tampered rewrap accepted")
	}
	// Even rewrapping a current-key envelope must authenticate and use a fresh nonce.
	again, err := current.Rewrap(fixtureBinding, rotated)
	if err != nil || bytes.Equal(again.raw(), rotated.raw()) {
		t.Fatal("nonce reused during rewrap")
	}
}

func TestInputBoundsAndKeyImmutability(t *testing.T) {
	keys := map[string][]byte{"fixture-v1": fixtureKey(1)}
	r := fixtureRing(t, "fixture-v1", keys)
	e := fixtureSeal(t, r, []byte("synthetic-token"))
	clear(keys["fixture-v1"])
	delete(keys, "fixture-v1")
	got, err := r.Open(fixtureBinding, e)
	if err != nil || string(got) != "synthetic-token" {
		t.Fatal("input key mutation changed ring")
	}
	clear(got)
	wire := e.Binary()
	parsed, err := ParseEnvelope(wire)
	if err != nil {
		t.Fatal(err)
	}
	clear(wire)
	copy := parsed.Binary()
	clear(copy)
	got, err = r.Open(fixtureBinding, parsed)
	if err != nil || string(got) != "synthetic-token" {
		t.Fatal("storage buffer mutation changed envelope")
	}
	clear(got)
	for _, secret := range [][]byte{nil, {}, make([]byte, MaxPlaintextBytes+1)} {
		if e, err := r.Seal(fixtureBinding, secret); e.raw() != nil || err != ErrInput {
			t.Fatal("invalid plaintext accepted")
		}
	}
	for _, mutate := range []func(*Binding){
		func(b *Binding) { b.ClientID = "" }, func(b *Binding) { b.ClientID = "00000000-0000-0000-0000-000000000000" },
		func(b *Binding) { b.ConnectionID = "invalid" }, func(b *Binding) { b.ClientID = "10000000-0000-4000-8000-00000000000A" },
		func(b *Binding) { b.Provider = "https://fixture.example" }, func(b *Binding) { b.Purpose = "token\x00other" },
		func(b *Binding) { b.Provider = "" }, func(b *Binding) { b.Purpose = strings.Repeat("a", 65) },
	} {
		b := fixtureBinding
		mutate(&b)
		if e, err := r.Seal(b, []byte("synthetic-token")); e.raw() != nil || err != ErrInput {
			t.Fatal("invalid binding accepted")
		}
		if got, err := r.Open(b, e); got != nil || err != ErrOpen {
			t.Fatal("invalid binding opened")
		}
	}
	for _, ring := range []*Keyring{nil, {}} {
		if e, err := ring.Seal(fixtureBinding, []byte("synthetic-token")); e.raw() != nil || err != ErrKeyring {
			t.Fatal("unavailable ring accepted")
		}
	}
	for _, wire := range [][]byte{nil, {1}, make([]byte, MaxEnvelopeBytes+1)} {
		if e, err := ParseEnvelope(wire); e.raw() != nil || err != ErrOpen {
			t.Fatal("invalid storage input accepted")
		}
	}
}

func TestNewRejectsInvalidKeyrings(t *testing.T) {
	tooMany := map[string][]byte{}
	for i := 0; i < MaxKeys+1; i++ {
		tooMany[fmt.Sprintf("fixture-%d", i)] = fixtureKey(byte(i + 1))
	}
	for _, tc := range []struct {
		active string
		keys   map[string][]byte
	}{
		{"", nil}, {"fixture-v1", nil}, {"fixture-v1", map[string][]byte{"other": fixtureKey(1)}},
		{"fixture-v1", map[string][]byte{"fixture-v1": make([]byte, 32)}},
		{"fixture-v1", map[string][]byte{"fixture-v1": fixtureKey(1), "fixture-v2": fixtureKey(1)}},
		{"fixture-v1", map[string][]byte{"fixture-v1": make([]byte, 31)}},
		{"fixture-v1", map[string][]byte{"fixture-v1": make([]byte, 33)}},
		{"fixture-v1", map[string][]byte{"fixture-v1": fixtureKey(1), "invalid/path": fixtureKey(2)}},
		{strings.Repeat("a", 65), map[string][]byte{strings.Repeat("a", 65): fixtureKey(1)}},
		{"fixture-0", tooMany},
	} {
		if r, err := New(tc.active, tc.keys); r != nil || err != ErrKeyring {
			t.Fatal("invalid ring accepted")
		}
	}
}

func TestConcurrentEncryptionUsesIndependentNonces(t *testing.T) {
	r := fixtureRing(t, "fixture-v1", map[string][]byte{"fixture-v1": fixtureKey(1)})
	results := make(chan []byte, 128)
	var wg sync.WaitGroup
	for i := 0; i < 128; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			e, err := r.Seal(fixtureBinding, []byte("synthetic-token"))
			if err != nil {
				t.Error("concurrent seal failed")
				return
			}
			got, err := r.Open(fixtureBinding, e)
			if err != nil || string(got) != "synthetic-token" {
				t.Error("concurrent open failed")
			}
			clear(got)
			results <- e.Binary()
		}()
	}
	wg.Wait()
	close(results)
	seen := map[string]bool{}
	for wire := range results {
		n := 2 + int(wire[1])
		nonce := string(wire[n : n+12])
		if seen[nonce] {
			t.Fatal("random nonce reused")
		}
		seen[nonce] = true
	}
	if len(seen) != 128 {
		t.Fatal("concurrent operations incomplete")
	}
}

func TestSensitiveObjectsRedactEveryDefaultOutput(t *testing.T) {
	r := fixtureRing(t, "fixture-v1", map[string][]byte{"fixture-v1": fixtureKey(0x42)})
	e := fixtureSeal(t, r, []byte("synthetic-token"))
	for i, object := range []any{r, *r, e, &e, struct{ Envelope Envelope }{e}, struct{ Ring *Keyring }{r}} {
		for _, format := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d", "%p"} {
			t.Run(fmt.Sprintf("object-%d-%s", i, format), func(t *testing.T) {
				got := fmt.Sprintf(format, object)
				assertRedacted(t, got, e)
			})
		}
		if got, err := json.Marshal(object); err == nil || len(got) != 0 {
			t.Fatal("sensitive object serialized")
		}
		for _, jsonLogs := range []bool{false, true} {
			var output bytes.Buffer
			var handler slog.Handler = slog.NewTextHandler(&output, nil)
			if jsonLogs {
				handler = slog.NewJSONHandler(&output, nil)
			}
			slog.New(handler).Info("synthetic test", "value", object)
			assertRedacted(t, output.String(), e)
		}
	}
}

func assertRedacted(t *testing.T, output string, e Envelope) {
	t.Helper()
	for _, private := range []string{"synthetic-token", strings.Repeat("B", 32), base64.StdEncoding.EncodeToString(fixtureKey(0x42)), fmt.Sprintf("%x", e.raw()), fmt.Sprintf("%v", e.raw()), string(e.raw()), base64.StdEncoding.EncodeToString(e.raw()), "fixture-v1"} {
		if strings.Contains(output, private) {
			t.Fatal("sensitive output exposed")
		}
	}
}

func FuzzEnvelopeNeverPanicsOrOpensTampering(f *testing.F) {
	r, err := New("fixture-v1", map[string][]byte{"fixture-v1": fixtureKey(1)})
	if err != nil {
		f.Fatal(err)
	}
	e, err := r.Seal(fixtureBinding, []byte("synthetic-token"))
	if err != nil {
		f.Fatal(err)
	}
	f.Add(e.Binary())
	f.Add([]byte{})
	f.Add([]byte{1, 1, 'a'})
	f.Add(make([]byte, MaxEnvelopeBytes+1))
	f.Fuzz(func(t *testing.T, wire []byte) {
		parsed, err := ParseEnvelope(wire)
		if err != nil {
			if parsed.raw() != nil || err != ErrOpen {
				t.Fatal("unsafe parse failure")
			}
			return
		}
		got, err := r.Open(fixtureBinding, parsed)
		if err != nil {
			if got != nil || err != ErrOpen {
				t.Fatal("unsafe open failure")
			}
			return
		}
		defer clear(got)
		if string(got) != "synthetic-token" {
			t.Fatal("unauthenticated ciphertext opened")
		}
	})
}
