package clients

import "testing"

func TestWebsiteNormalizationPreservesPropertyIdentity(t *testing.T) {
	for _, test := range []struct{ input, url, domain string }{
		{"HTTPS://Shop.Example.COM/", "https://shop.example.com", "shop.example.com"},
		{"shop.example.com/shop", "https://shop.example.com/shop", "shop.example.com"},
		{"https://xn--bcher-kva.example/path", "https://xn--bcher-kva.example/path", "xn--bcher-kva.example"},
		{"http://www.example.com:8080/store", "http://www.example.com:8080/store", "www.example.com"},
	} {
		p, err := normalizeWebsite(WebsiteProfile{Name: " Property ", URL: test.input})
		if err != nil || p.URL != test.url || p.Domain != test.domain || p.Name != "Property" {
			t.Fatalf("normalization failed for %q", test.input)
		}
	}
	for _, input := range []string{"javascript:alert(1)", "https://user:password@example.com", "https://example.com?key=value", "https://example.com/#fragment", "https://example..com", "https://-example.com", "https://example-.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://example.com:0", "https://example.com:65536", "https://example.com\n", "https://bücher.example"} {
		if _, err := normalizeWebsite(WebsiteProfile{Name: "Property", URL: input}); err == nil {
			t.Fatalf("invalid website accepted: %q", input)
		}
	}
}
