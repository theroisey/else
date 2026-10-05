package activity

import (
	"encoding/base64"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testClient = "11111111-1111-4111-8111-111111111111"
const testEvent = "22222222-2222-4222-8222-222222222222"

func TestCursorPreservesMicrosecondsAndClientBoundary(t *testing.T) {
	stamp := time.Date(2026, 10, 2, 12, 30, 0, 123456000, time.FixedZone("offset", 19800))
	raw := encodeCursor(testClient, Item{ID: testEvent, OccurredAt: stamp})
	b, err := decodeCursor(strings.ToUpper(testClient), raw)
	if err != nil || b.ID != testEvent || !b.Time.Equal(stamp) || b.Time.Location() != time.UTC {
		t.Fatal("cursor changed ordering boundary", b, err)
	}
	if _, err := decodeCursor(testEvent, raw); err == nil {
		t.Fatal("cursor accepted another client")
	}
	if b, err := decodeCursor(testClient, ""); err != nil || b != nil {
		t.Fatal("empty cursor is not first page")
	}
}
func TestCursorRejectsMalformedNoncanonicalAndExcessPrecision(t *testing.T) {
	enc := func(v string) string { return base64.RawURLEncoding.EncodeToString([]byte(v)) }
	valid := encodeCursor(testClient, Item{ID: testEvent, OccurredAt: time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)})
	bad := []string{strings.Repeat("A", 257), "%", valid + "=", valid + "\n", enc("v2|" + testClient + "|2026-10-02T12:00:00Z|" + testEvent)}
	for _, stamp := range []string{"2026-02-30T12:00:00Z", "0000-01-01T00:00:00Z", "2026-10-02T12:00:00.0000001Z", "2026-10-02T12:00:00+00:00", "2026-10-02T12:00:00.000000Z", "infinity"} {
		bad = append(bad, enc("v1|"+testClient+"|"+stamp+"|"+testEvent))
	}
	bad = append(bad, enc("v1|"+testClient+"|2026-10-02T12:00:00Z|00000000-0000-0000-0000-000000000000"), enc("v1|"+testClient+"|2026-10-02T12:00:00Z|"+testEvent+"|extra"))
	for _, raw := range bad {
		if _, err := decodeCursor(testClient, raw); err == nil {
			t.Fatal("accepted invalid cursor", raw)
		}
	}
}
func TestActivityQueryRejectsUnboundedAndUnknownInputs(t *testing.T) {
	for _, query := range []string{"limit=0", "limit=101", "limit=-1", "limit=abc", "limit=99999999999999999999", "limit=", "cursor=", "limit=1&limit=2", "cursor=a&cursor=b", "offset=0", "q=private", "sort=id", "before_state=x", "%zz=1", "limit=1;cursor=x", "x=" + strings.Repeat("a", 1024)} {
		if _, err := parseFilter(httptest.NewRequest("GET", "/activity?"+query, nil)); err == nil {
			t.Fatal("accepted hostile query", query)
		}
	}
	for _, query := range []string{"", "limit=1", "limit=100", "cursor=bounded"} {
		if _, err := parseFilter(httptest.NewRequest("GET", "/activity?"+query, nil)); err != nil {
			t.Fatal("valid query failed", query)
		}
	}
}
func TestActivityLabelsExcludeSecurityAndUnknownEvents(t *testing.T) {
	if len(summaries) != 21 || summaries["task.completed"] != "Task completed." || summaries["milestone.updated"] != "Milestone updated." {
		t.Fatal("activity labels incomplete")
	}
	for _, event := range []string{"user.created", "role.updated", "role_assignment.created", "client.deleted", "task.deleted", "task.secret", "unknown.created", "reminder.delivered"} {
		if summaries[event] != "" {
			t.Fatal("unreviewed event has activity summary", event)
		}
	}
}
