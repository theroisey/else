package connections

import (
	"encoding/base64"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testClient = "33333333-3333-4333-8333-333333333331"
const testConnection = "e3000000-0000-4000-8000-000000000001"

func TestCursorRejectsCrossClientAndNoncanonicalInputs(t *testing.T) {
	cursor := encodeCursor(testClient, testConnection)
	id, err := decodeCursor(testClient, cursor)
	if err != nil || id != testConnection {
		t.Fatal("cursor round trip", err)
	}
	for _, raw := range []string{cursor + "=", cursor + "\n", strings.Repeat("a", 129), "!", encodeCursor(testConnection, testConnection), encodeCursor(testClient, strings.ToUpper(testConnection)), encodeCursor(testClient, "00000000-0000-0000-0000-000000000000"), base64.RawURLEncoding.EncodeToString([]byte("v2|" + testClient + "|" + testConnection))} {
		if _, err := decodeCursor(testClient, raw); err != ErrInvalid {
			t.Fatal("unsafe cursor accepted")
		}
	}
}

func TestStrictBoundedFilter(t *testing.T) {
	for _, query := range []string{"?", "?limit=0", "?limit=101", "?limit=", "?limit=1&limit=2", "?cursor=", "?cursor=a&cursor=b", "?unknown=1", "?limit=%ZZ", "?limit=1;cursor=a", "?cursor=" + strings.Repeat("x", 513)} {
		if _, err := parseFilter(httptest.NewRequest("GET", "https://example.com/"+query, nil)); err != ErrInvalid {
			t.Fatal("unsafe query accepted", query)
		}
	}
	for _, query := range []string{"", "?limit=1", "?limit=100&cursor=abc"} {
		if _, err := parseFilter(httptest.NewRequest("GET", "https://example.com/"+query, nil)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStoredMetadataValidationAndExactRevision(t *testing.T) {
	stamp := time.Date(2026, 10, 3, 0, 0, 0, 123000, time.UTC)
	c := Connection{ID: testConnection, ClientID: testClient, Provider: "meta_ads", State: "pending", Revision: "9223372036854775807", CreatedAt: stamp, UpdatedAt: stamp}
	for _, provider := range []string{"meta_ads", "ga4", "woocommerce"} {
		c.Provider = provider
		if !validConnection(c, testClient) {
			t.Fatal("selected stored provider rejected")
		}
	}
	for _, state := range []string{"pending", "connected", "disconnect_pending", "revocation_failed", "disconnected", "reauthorization_required"} {
		c.State = state
		if !validConnection(c, testClient) {
			t.Fatal("stored state rejected")
		}
	}
	for _, revision := range []string{"0", "-1", "01", "1.0", "9223372036854775808"} {
		bad := c
		bad.Revision = revision
		if validConnection(bad, testClient) {
			t.Fatal("invalid revision accepted")
		}
	}
	for _, change := range []func(*Connection){func(c *Connection) { c.ClientID = testConnection }, func(c *Connection) { c.Provider = "other" }, func(c *Connection) { c.State = "success" }, func(c *Connection) { c.CreatedAt = c.CreatedAt.Add(time.Nanosecond) }, func(c *Connection) { c.UpdatedAt = c.CreatedAt.Add(-time.Microsecond) }, func(c *Connection) { c.UpdatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC) }} {
		bad := c
		change(&bad)
		if validConnection(bad, testClient) {
			t.Fatal("unsafe stored metadata accepted")
		}
	}
	if _, err := NewService(nil); err != ErrInvalid {
		t.Fatal("nil pool accepted")
	}
	if _, err := NewHandler(nil, nil, nil); err != ErrInvalid {
		t.Fatal("nil dependencies accepted")
	}
}
