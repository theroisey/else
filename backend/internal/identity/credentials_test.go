package identity

import (
	"strings"
	"testing"
)

func TestArgonPasswordRoundTripAndParserBounds(t *testing.T) {
	hasher := ArgonPasswords{}
	hash, err := hasher.Hash("correct horse battery staple")
	if err != nil || strings.Contains(hash, "correct") || !hasher.Verify(hash, "correct horse battery staple") || hasher.Verify(hash, "wrong password") {
		t.Fatal("password hashing contract failed")
	}
	for _, candidate := range []string{
		"", "$argon2id$v=19$m=999999999,t=2,p=1$AAAA$AAAA",
		strings.Replace(hash, "m=19456", "m=19457", 1), strings.Replace(hash, "t=2", "t=20", 1),
		strings.Replace(hash, "p=1", "p=8", 1), strings.Replace(hash, "v=19", "v=16", 1),
		hash + "$extra", strings.Replace(hash, "$argon2id$", "$argon2i$", 1),
	} {
		if hasher.Verify(candidate, "correct horse battery staple") {
			t.Fatal("untrusted PHC parameters accepted")
		}
	}
}

func TestIdentityInputPolicy(t *testing.T) {
	if email, ok := canonicalEmail("  USER@Example.COM "); !ok || email != "user@example.com" {
		t.Fatal("email was not canonicalized")
	}
	for _, email := range []string{"", "person@example", "person @example.com", strings.Repeat("a", 255) + "@example.com"} {
		if _, ok := canonicalEmail(email); ok {
			t.Fatal("invalid email accepted")
		}
	}
	for _, password := range []string{"short", strings.Repeat("x", 129), string([]byte{0xff, 0xfe})} {
		if validPassword(password) {
			t.Fatal("invalid password accepted")
		}
	}
	if !validPassword("twelve-bytes!") || !validDisplayName("Example User") || validDisplayName(" Example User ") || validDisplayName("") {
		t.Fatal("identity field policy failed")
	}
}

func TestRandomSecretsAndIDs(t *testing.T) {
	a, ad, err := randomSecret()
	if err != nil {
		t.Fatal(err)
	}
	b, bd, err := randomSecret()
	if err != nil {
		t.Fatal(err)
	}
	if a == b || ad == bd || len(a) != 43 {
		t.Fatal("secrets were missing entropy")
	}
	if got, ok := secretDigest(a); !ok || got != ad {
		t.Fatal("secret digest mismatch")
	}
	for _, raw := range []string{"", a + "=", "not-a-token"} {
		if _, ok := secretDigest(raw); ok {
			t.Fatal("invalid token accepted")
		}
	}
	id, err := newID()
	if err != nil || len(id) != 36 || id[14] != '4' {
		t.Fatal("UUID generation failed")
	}
}
