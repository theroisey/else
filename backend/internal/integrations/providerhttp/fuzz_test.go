package providerhttp

import (
	"net/netip"
	"strings"
	"testing"
)

func FuzzCanonicalOrigin(f *testing.F) {
	for _, raw := range []string{"https://shop.example.com", "https://shop.example.com/store", "https://user:synthetic-secret@shop.example.com", "https://127.0.0.1", "https://shop.example.com/%2e%2e/private", "https://shop.example.com?consumer_secret=synthetic-secret"} {
		f.Add(raw)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		origin, err := parseOrigin(raw)
		if err != nil {
			if origin != nil || err != ErrUnavailable {
				t.Fatal("origin error exposed partial state or detail")
			}
			return
		}
		if origin == nil || origin.Scheme != "https" || origin.User != nil || origin.Port() != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.RawPath != "" || origin.String() != raw || !strings.Contains(origin.Host, ".") || strings.HasSuffix(origin.Path, "/") {
			t.Fatal("accepted origin escaped trusted HTTPS identity")
		}
		if _, err := netip.ParseAddr(origin.Hostname()); err == nil {
			t.Fatal("literal IP origin accepted")
		}
	})
}
