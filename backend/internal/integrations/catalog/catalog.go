// Package catalog owns the explicitly selected stored provider identities.
// It does not authorize credentials, network destinations or account ownership.
package catalog

// CredentialPurpose is an authenticated encryption binding, not a declaration
// of the provider authentication flow or a validation of its opaque payload.
func CredentialPurpose(provider string) (string, bool) {
	switch provider {
	case "meta_ads":
		return "access_token", true // Preserve existing Meta ciphertext exactly.
	case "ga4", "woocommerce":
		return "provider_credential", true
	default:
		return "", false
	}
}

func Supported(provider string) bool {
	_, ok := CredentialPurpose(provider)
	return ok
}
