package analytics

import (
	"net/url"
	"strings"
	"testing"
)

func TestStrictSetupBodyDoesNotAcceptAliasesDuplicatesOrExtraPrivateFields(t *testing.T) {
	allowed := []string{"revision", "since", "until", "credential_json"}
	valid := `{"revision":"1","since":"2026-10-01","until":"2026-10-03","credential_json":"synthetic"}`
	if fields, err := decodeFields(strings.NewReader(valid), allowed); err != nil || len(fields) != 4 {
		t.Fatal("valid setup shape unavailable")
	}
	for _, raw := range []string{
		strings.Replace(valid, "revision", "Revision", 1),
		strings.Replace(valid, `"revision":"1"`, `"revision":"1","revi\u0073ion":"1"`, 1),
		strings.Replace(valid, `"revision":"1"`, `"revision":1`, 1),
		strings.Replace(valid, `"credential_json":"synthetic"`, `"credential_json":null`, 1),
		strings.Replace(valid, `"revision":"1"`, `"revision":"1","endpoint":"https://unapproved.example.com"`, 1),
		valid + valid, "null", "[]", `{}`, strings.Replace(valid, `,"credential_json":"synthetic"`, "", 1),
	} {
		if fields, err := decodeFields(strings.NewReader(raw), allowed); err != ErrInvalid || fields != nil {
			t.Fatal("ambiguous/private setup input accepted")
		}
	}
}

func TestPeriodQueryCannotExpandTheReportOrExposeCredentials(t *testing.T) {
	for _, query := range []string{"since=2026-10-01&until=2026-10-31", "until=2026-10-03&since=2026-10-01"} {
		if _, _, err := periodQuery(&url.URL{RawQuery: query}); err != nil {
			t.Fatal("supported property-local period unavailable")
		}
	}
	for _, query := range []string{"", "since=2026-10-01", "since=2026-10-01&until=2026-11-01", "since=2026-10-02&until=2026-10-01", "since=2026-02-31&until=2026-03-01", "since=2026-10-01&since=2026-10-02&until=2026-10-03", "since=2026-10-01&until=2026-10-03&token=private", "since=2026-10-01&until=2026-10-03&metrics=custom"} {
		if since, until, err := periodQuery(&url.URL{RawQuery: query}); err != ErrInvalid || since != "" || until != "" {
			t.Fatal("unbounded/private report query accepted")
		}
	}
}
