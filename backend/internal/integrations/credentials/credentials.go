// Package credentials encrypts backend integration secrets. It does not authorize
// access: callers must resolve a connection and its binding under current grants.
package credentials

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
)

const (
	MaxPlaintextBytes = 16 * 1024
	MaxKeys           = 8
	MaxKeyringBytes   = 8 * 1024
	MaxEnvelopeBytes  = 2 + 64 + 28 + MaxPlaintextBytes
	envelopeVersion   = 1
)

var (
	ErrKeyring = errors.New("integration credential key ring unavailable")
	ErrInput   = errors.New("invalid integration credential input")
	ErrOpen    = errors.New("integration credential unavailable")
	label      = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	uuid       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// Binding must come from trusted, immutable connection metadata. Provider and
// purpose are adapter-owned identifiers, not URLs, account labels or secrets.
type Binding struct {
	ClientID     string
	ConnectionID string
	Provider     string
	Purpose      string
}

func (b Binding) valid() bool {
	return validID(b.ClientID) && validID(b.ConnectionID) && label.MatchString(b.Provider) && label.MatchString(b.Purpose)
}

func validID(id string) bool {
	return uuid.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
}

// Keyring is immutable and safe for concurrent use. Construct a replacement to
// rotate keys; retain old keys until live ciphertext and backup retention permit
// removal. The caller owns and must protect/clear input key buffers.
type Keyring struct{ state *ringState }

// Indirection also prevents fmt's unsupported-verb diagnostics from expanding
// sensitive fields: those diagnostics can bypass an outer Formatter method.
type ringState struct {
	active string
	keys   map[string]cipher.AEAD
}

// New accepts independently provisioned random 32-byte keys. It retains no input
// buffers. Key labels and key material must both be distinct across versions.
func New(active string, keys map[string][]byte) (*Keyring, error) {
	if !label.MatchString(active) || len(keys) == 0 || len(keys) > MaxKeys {
		return nil, ErrKeyring
	}
	ring := &Keyring{state: &ringState{active: active, keys: make(map[string]cipher.AEAD, len(keys))}}
	seen := make(map[[32]byte]bool, len(keys))
	for id, key := range keys {
		if !label.MatchString(id) || len(key) != 32 {
			return nil, ErrKeyring
		}
		var zero [32]byte
		digest := sha256.Sum256(key)
		if bytes.Equal(key, zero[:]) || seen[digest] {
			return nil, ErrKeyring
		}
		seen[digest] = true
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, ErrKeyring
		}
		aead, err := cipher.NewGCMWithRandomNonce(block)
		if err != nil {
			return nil, ErrKeyring
		}
		ring.state.keys[id] = aead
	}
	if ring.state.keys[active] == nil {
		return nil, ErrKeyring
	}
	return ring, nil
}

// Envelope is opaque. Default formatting and JSON redact its bytes. Binary is
// the explicit persistence boundary and returns an independent copy.
type Envelope struct{ state *envelopeState }
type envelopeState struct{ data []byte }

func (e Envelope) raw() []byte {
	if e.state == nil {
		return nil
	}
	return e.state.data
}

func (e Envelope) Binary() []byte { return append([]byte(nil), e.raw()...) }

// ParseEnvelope bounds and copies storage input. Parsing does not authenticate
// the header or ciphertext; only a successful Open establishes authenticity.
func ParseEnvelope(data []byte) (Envelope, error) {
	if _, _, ok := split(data); !ok {
		return Envelope{}, ErrOpen
	}
	return Envelope{state: &envelopeState{data: append([]byte(nil), data...)}}, nil
}

func split(data []byte) (header, encrypted []byte, ok bool) {
	if len(data) < 2 || len(data) > MaxEnvelopeBytes || data[0] != envelopeVersion {
		return nil, nil, false
	}
	n := int(data[1])
	if n < 1 || n > 64 || len(data) < 2+n+28+1 || len(data) > 2+n+28+MaxPlaintextBytes || !label.Match(data[2:2+n]) {
		return nil, nil, false
	}
	return data[:2+n], data[2+n:], true
}

func associatedData(b Binding, header []byte) []byte {
	data := append([]byte("roisey-else/integration-credential\x00"), header...)
	for _, field := range []string{b.ClientID, b.ConnectionID, b.Provider, b.Purpose} {
		data = append(data, 0)
		data = append(data, field...)
	}
	return data
}

// Seal encrypts with the active key and a fresh standard-library random nonce.
// Across all processes and restarts, a key must encrypt fewer than 2^32 messages.
// Nonce generation failure is a fatal crypto/rand failure, never a fallback nonce.
func (r *Keyring) Seal(b Binding, plaintext []byte) (Envelope, error) {
	if r == nil || r.state == nil || r.state.keys[r.state.active] == nil {
		return Envelope{}, ErrKeyring
	}
	if !b.valid() || len(plaintext) == 0 || len(plaintext) > MaxPlaintextBytes {
		return Envelope{}, ErrInput
	}
	header := append([]byte{envelopeVersion, byte(len(r.state.active))}, r.state.active...)
	encrypted := r.state.keys[r.state.active].Seal(nil, nil, plaintext, associatedData(b, header))
	return Envelope{state: &envelopeState{data: append(header, encrypted...)}}, nil
}

// Open uses retained keys and returns plaintext only after authentication. All
// malformed, missing-key, wrong-key, tampering and binding failures are identical.
// Callers must never log plaintext and should clear the returned buffer promptly.
func (r *Keyring) Open(b Binding, e Envelope) ([]byte, error) {
	if r == nil || r.state == nil || !b.valid() {
		return nil, ErrOpen
	}
	header, encrypted, ok := split(e.raw())
	if !ok {
		return nil, ErrOpen
	}
	aead := r.state.keys[string(header[2:])]
	if aead == nil {
		return nil, ErrOpen
	}
	plaintext, err := aead.Open(nil, nil, encrypted, associatedData(b, header))
	if err != nil {
		return nil, ErrOpen
	}
	return plaintext, nil
}

// Rewrap authenticates with a retained key and encrypts with the active key and
// a fresh nonce. The later persistence owner must replace ciphertext atomically;
// this method does not update storage, audit history or a rotation checkpoint.
func (r *Keyring) Rewrap(b Binding, e Envelope) (Envelope, error) {
	plaintext, err := r.Open(b, e)
	if err != nil {
		return Envelope{}, err
	}
	defer clear(plaintext)
	return r.Seal(b, plaintext)
}

func (Keyring) Format(s fmt.State, _ rune) {
	_, _ = io.WriteString(s, "[redacted integration key ring]")
}
func (Envelope) Format(s fmt.State, _ rune) {
	_, _ = io.WriteString(s, "[redacted integration envelope]")
}
func (Keyring) LogValue() slog.Value          { return slog.StringValue("[redacted integration key ring]") }
func (Envelope) LogValue() slog.Value         { return slog.StringValue("[redacted integration envelope]") }
func (Keyring) MarshalJSON() ([]byte, error)  { return nil, ErrKeyring }
func (Envelope) MarshalJSON() ([]byte, error) { return nil, ErrOpen }
