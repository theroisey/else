package credentials

import (
	"bytes"
	"crypto/sha256"
	"testing"
)

func TestActiveIdentityCopiesAndNamesMaterial(t *testing.T) {
	material := bytes.Repeat([]byte{0x6b}, 32)
	ring, e := New("synthetic-one", map[string][]byte{"synthetic-one": material})
	if e != nil {
		t.Fatal(e)
	}
	name, digest, e := ring.ActiveKeyIdentity()
	if e != nil || name != "synthetic-one" || digest != sha256.Sum256(material) {
		t.Fatal("identity mismatch", e)
	}
	original := digest
	clear(material)
	digest[0] ^= 0xff
	_, again, e := ring.ActiveKeyIdentity()
	if e != nil || again != original {
		t.Fatal("identity aliases input or output")
	}
	renamed, e := New("synthetic-two", map[string][]byte{"synthetic-two": bytes.Repeat([]byte{0x6b}, 32)})
	if e != nil {
		t.Fatal(e)
	}
	_, same, e := renamed.ActiveKeyIdentity()
	if e != nil || same != original {
		t.Fatal("label changes material identity")
	}
	for _, invalid := range []*Keyring{nil, {}} {
		if _, _, e := invalid.ActiveKeyIdentity(); e != ErrKeyring {
			t.Fatal("empty key ring identity")
		}
	}
}
