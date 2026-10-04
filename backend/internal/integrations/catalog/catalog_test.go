package catalog

import (
	"bytes"
	"testing"

	"github.com/theroisey/else/backend/internal/integrations/credentials"
)

func TestSelectedProvidersRemainSeparateAuthenticatedBindings(t *testing.T) {
	ring, err := credentials.New("synthetic", map[string][]byte{"synthetic": bytes.Repeat([]byte{0x61}, 32)})
	if err != nil {
		t.Fatal(err)
	}
	for _, provider := range []string{"meta_ads", "ga4", "woocommerce"} {
		purpose, ok := CredentialPurpose(provider)
		if !ok || (provider == "meta_ads" && purpose != "access_token") {
			t.Fatal("catalog changed existing binding")
		}
		b := credentials.Binding{ClientID: "10000000-0000-4000-8000-000000000001", ConnectionID: "20000000-0000-4000-8000-000000000001", Provider: provider, Purpose: purpose}
		envelope, err := ring.Seal(b, []byte("synthetic-provider-credential"))
		if err != nil {
			t.Fatal(err)
		}
		plain, err := ring.Open(b, envelope)
		if err != nil || !bytes.Equal(plain, []byte("synthetic-provider-credential")) {
			t.Fatal("catalog ciphertext cannot authenticate")
		}
		clear(plain)
		for _, other := range []string{"meta_ads", "ga4", "woocommerce"} {
			if other == provider {
				continue
			}
			wrong := b
			wrong.Provider = other
			wrong.Purpose, _ = CredentialPurpose(other)
			if plain, err := ring.Open(wrong, envelope); plain != nil || err != credentials.ErrOpen {
				clear(plain)
				t.Fatal("cross-provider ciphertext authenticated")
			}
		}
		wrong := b
		wrong.Purpose = "different_purpose"
		if plain, err := ring.Open(wrong, envelope); plain != nil || err != credentials.ErrOpen {
			clear(plain)
			t.Fatal("cross-purpose ciphertext authenticated")
		}
	}
	for _, provider := range []string{"", "other", "GA4", "ga4 ", "meta_ads\x00", "https://shop.example.com"} {
		if purpose, ok := CredentialPurpose(provider); ok || purpose != "" || Supported(provider) {
			t.Fatal("unselected provider accepted")
		}
	}
}
