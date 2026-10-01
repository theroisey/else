package config

import "testing"

func TestAuthConfigurationRequiresSafeOrigin(t *testing.T) {
	valid := map[string]string{"AUTH_PUBLIC_ORIGIN": "https://else.example"}
	lookup := func(key string) (string, bool) { value, ok := valid[key]; return value, ok }
	if c, err := LoadAuth(lookup); err != nil || !c.CookieSecure {
		t.Fatal("secure origin rejected")
	}
	for _, values := range []map[string]string{
		{},
		{"AUTH_PUBLIC_ORIGIN": "http://else.example", "AUTH_COOKIE_SECURE": "false"},
		{"AUTH_PUBLIC_ORIGIN": "https://else.example/path"},
		{"AUTH_PUBLIC_ORIGIN": "https://user@else.example"},
		{"AUTH_PUBLIC_ORIGIN": "http://localhost:5173"},
		{"AUTH_PUBLIC_ORIGIN": "http://localhost:5173", "AUTH_COOKIE_SECURE": "invalid"},
	} {
		lookup := func(key string) (string, bool) { value, ok := values[key]; return value, ok }
		if _, err := LoadAuth(lookup); err == nil {
			t.Fatalf("unsafe auth configuration accepted: %v", values)
		}
	}
	local := map[string]string{"AUTH_PUBLIC_ORIGIN": "http://localhost:5173", "AUTH_COOKIE_SECURE": "false"}
	lookup = func(key string) (string, bool) { value, ok := local[key]; return value, ok }
	if _, err := LoadAuth(lookup); err != nil {
		t.Fatal(err)
	}
}
