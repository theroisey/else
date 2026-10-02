package auditreader

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const clientID = "11111111-1111-4111-8111-111111111111"
const otherID = "22222222-2222-4222-8222-222222222222"

func TestFilterBoundsAndUTCPrecision(t *testing.T) {
	query := "?limit=100&actor_id=" + otherID + "&actor_kind=user&event_type=task.updated&client_id=" + clientID + "&resource_kind=task&resource_id=" + otherID + "&request_id=" + strings.Repeat("A", 26) + "&from=0001-01-01T00:00:00Z&to=9999-12-31T23:59:59.999999Z"
	f, err := parseFilter(httptest.NewRequest("GET", "/api/v1/audit-logs"+query, nil), "")
	if err != nil || f.Limit != 100 || f.From.Year() != 1 || f.To.Nanosecond() != 999999000 {
		t.Fatal("bounded exact filters rejected", err)
	}
	for _, q := range []string{"?limit=0", "?limit=101", "?limit=25&limit=25", "?actor_id=invalid", "?actor_kind=admin", "?event_type=role.disabled", "?event_type=task.completed\n", "?resource_kind=private.value", "?resource_id=00000000-0000-0000-0000-000000000000", "?request_id=private", "?from=0000-01-01T00:00:00Z", "?from=2026-02-30T00:00:00Z", "?to=2026-10-02T12:00:00.1234567Z", "?from=2026-10-02T00:00:00%2B00:00", "?from=2026-10-02T00:00:00Z&to=2026-10-02T00:00:00Z", "?cursor=" + strings.Repeat("a", 257), "?unknown=1", "?offset=1", "?actor_id=", "?bad=%", "?q=" + strings.Repeat("x", 2048)} {
		r := httptest.NewRequest("GET", "/api/v1/audit-logs", nil)
		r.URL.RawQuery = strings.TrimPrefix(q, "?")
		if _, err := parseFilter(r, ""); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid query accepted %q", q)
		}
	}
	if _, err := parseFilter(httptest.NewRequest("GET", "/api/v1/clients/"+clientID+"/audit-logs?client_id="+clientID, nil), clientID); !errors.Is(err, ErrInvalid) {
		t.Fatal("route client override accepted")
	}
}
func TestDateFiltersRejectExtraZeroPrecisionAndNonstandardSyntax(t *testing.T) {
	for _, stamp := range []string{"2026-10-02T12:00:00.1234560Z", "2026-10-02T12:00:00,123456Z", "2026-10-02T12:00:00.000000000Z"} {
		if _, err := parseFilter(httptest.NewRequest("GET", "/api/v1/audit-logs?from="+stamp, nil), ""); !errors.Is(err, ErrInvalid) {
			t.Fatal("excess precision or nonstandard timestamp accepted", stamp)
		}
	}
}

func TestCursorBindsScopeAndAllFiltersWithoutLosingMicroseconds(t *testing.T) {
	stamp := time.Date(2026, 10, 2, 12, 0, 0, 123456000, time.UTC)
	f, _ := normalize(clientID, Filter{Limit: 25, EventType: "task.updated"})
	raw := encodeCursor(clientID, f, Summary{ID: otherID, OccurredAt: stamp})
	f.Cursor = raw
	b, err := decodeCursor(clientID, f)
	if err != nil || b.ID != otherID || !b.Time.Equal(stamp) {
		t.Fatal("cursor lost boundary", err)
	}
	f.Limit = 100
	if _, err := decodeCursor(clientID, f); err != nil {
		t.Fatal("limit unnecessarily bound cursor")
	}
	for _, change := range []func(*Filter){func(f *Filter) { f.ActorID = otherID }, func(f *Filter) { f.ActorKind = "system" }, func(f *Filter) { f.EventType = "task.created" }, func(f *Filter) { f.ClientID = otherID }, func(f *Filter) { f.ResourceID = otherID }, func(f *Filter) { f.ResourceKind = "plan" }, func(f *Filter) { f.RequestID = strings.Repeat("B", 26) }, func(f *Filter) { f.From = &stamp }, func(f *Filter) { f.To = &stamp }} {
		changed := f
		change(&changed)
		if _, err := decodeCursor(clientID, changed); !errors.Is(err, ErrInvalid) {
			t.Fatal("cursor accepted changed filters")
		}
	}
	if _, err := decodeCursor("", f); !errors.Is(err, ErrInvalid) {
		t.Fatal("cursor accepted changed route")
	}
	for _, invalid := range []string{raw + "=", strings.Repeat("a", 257), "%", base64.RawURLEncoding.EncodeToString([]byte("v2|" + fingerprint(clientID, f) + "|" + stamp.Format(time.RFC3339Nano) + "|" + otherID)), base64.RawURLEncoding.EncodeToString([]byte("v1|" + fingerprint(clientID, f) + "|2026-10-02T12:00:00.1234567Z|" + otherID))} {
		changed := f
		changed.Cursor = invalid
		if _, err := decodeCursor(clientID, changed); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid cursor accepted")
		}
	}
}
func TestDetailProjectionPreservesInt64AndAllowsOnlyReviewedMarkers(t *testing.T) {
	raw := []byte(`{"exists":true,"revision":9223372036854775807,"reminder_status":"pending","reminder_scheduled_at":"2026-10-02T12:00:00.123456Z","reminder_timezone":"UTC"}`)
	snapshot, err := projectSnapshot(raw, "reminder")
	if err != nil || *snapshot.Revision != "9223372036854775807" || snapshot.ReminderScheduledAt.Nanosecond() != 123456000 {
		t.Fatal("safe marker precision lost", err)
	}
	encoded, _ := json.Marshal(snapshot)
	if !strings.Contains(string(encoded), `"revision":"9223372036854775807"`) {
		t.Fatal("revision converted to unsafe JavaScript number")
	}
	for _, raw := range []string{`{"revision":-1}`, `{"revision":9223372036854775808}`, `{"title":"private"}`, `{"status":"secret"}`, `{"task_status":"private"}`, `{"reminder_status":"pending"}`, `{"reminder_scheduled_at":"2026-10-02T00:00:00Z"}`, `{"reminder_scheduled_at":"2026-10-02T00:00:00.1234567Z","reminder_timezone":"UTC"}`, `{"reminder_timezone":"UTC"}`, `null {}`, `[]`} {
		if _, err := projectSnapshot([]byte(raw), "client"); err == nil {
			t.Fatal("unreviewed/malformed snapshot accepted", raw)
		}
	}
	for _, raw := range []string{`{"source":"private"}`, `{"source":"http","token":"private"}`, `null`, `{"source":7}`, strings.Repeat("a", 257)} {
		if _, err := projectMetadata([]byte(raw)); err == nil {
			t.Fatal("unreviewed metadata accepted", raw)
		}
	}
	for _, source := range []string{"http", "job", "cli"} {
		if _, err := projectMetadata([]byte(`{"source":"` + source + `"}`)); err != nil {
			t.Fatal(err)
		}
	}
	if s, err := projectSnapshot([]byte("null"), "client"); err != nil || s != nil {
		t.Fatal("null snapshot not retained")
	}
}
func TestAuditRoutesRejectExtraSegmentsAndInvalidReferences(t *testing.T) {
	for _, path := range []string{"/api/v1/audit-logs", "/api/v1/audit-logs/" + otherID, "/api/v1/clients/" + clientID + "/audit-logs", "/api/v1/clients/" + clientID + "/audit-logs/" + otherID} {
		if _, _, err := route(path); err != nil {
			t.Fatal("valid route rejected", path)
		}
	}
	for _, path := range []string{"/api/v1/audit-logs/", "/api/v1/audit-logs/" + otherID + "/edit", "/api/v1/audit-logs/private", "/api/v1/clients/invalid/audit-logs", "/api/v1/clients/" + clientID + "/audit-logs/", "/api/v1/clients/" + clientID + "/audit-logs/" + otherID + "/edit", "/other"} {
		if _, _, err := route(path); err == nil {
			t.Fatal("invalid route accepted", path)
		}
	}
}
