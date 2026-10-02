package planning

import (
	"errors"
	"math"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProfilesNormalizeUnicodeDatesAndRejectInvalidInput(t *testing.T) {
	start := time.Date(2026, 10, 2, 12, 0, 0, 123456789, time.FixedZone("offset", 3*3600))
	due := start.Add(time.Hour)
	p, err := normalize(Profile{Title: "  " + strings.Repeat("世", 200) + "  ", Description: " first\r\nsecond ", StartAt: &start, DueAt: &due}, false)
	if err != nil || p.Description != "first\nsecond" || p.StartAt.Location() != time.UTC || p.StartAt.Nanosecond() != 123456000 || !p.StartAt.Equal(start.Truncate(time.Microsecond)) {
		t.Fatal("normalization failed", err)
	}
	for _, invalid := range []Profile{{Title: ""}, {Title: strings.Repeat("世", 201)}, {Title: "a\nb"}, {Title: "a\x00b"}, {Title: "\xff"}, {Title: "ok", Description: strings.Repeat("世", 8001)}, {Title: "ok", Description: "a\tb"}} {
		if _, err := normalize(invalid, false); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid text accepted")
		}
	}
	if _, err := normalize(Profile{Title: "ok", StartAt: &due, DueAt: &start}, false); !errors.Is(err, ErrDates) {
		t.Fatal("reversed dates accepted")
	}
	if _, err := normalize(Profile{Title: "ok", StartAt: &start}, true); !errors.Is(err, ErrInvalid) {
		t.Fatal("milestone start date accepted")
	}
	for _, year := range []int{0, 10000} {
		v := time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC)
		if _, err := normalize(Profile{Title: "ok", DueAt: &v}, false); !errors.Is(err, ErrInvalid) {
			t.Fatal("unserializable date accepted")
		}
	}
}

func TestLinkSetAndRevisionValidation(t *testing.T) {
	id := "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
	ids, err := normalizedLinks([]string{id})
	if err != nil || ids[0] != strings.ToLower(id) {
		t.Fatal("UUID normalization failed")
	}
	ids, err = normalizedLinks(nil)
	if err != nil || ids == nil || len(ids) != 0 {
		t.Fatal("clear set must serialize as an empty array")
	}
	for _, input := range [][]string{{id, strings.ToLower(id)}, {"bad"}, {"00000000-0000-0000-0000-000000000000"}, make([]string, 51)} {
		if _, err := normalizedLinks(input); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid link set accepted")
		}
	}
	s := &Service{}
	for _, revision := range []int64{0, -1, math.MaxInt64} {
		if _, err := s.Update(t.Context(), strings.ToLower(id), strings.ToLower(id), "", strings.ToLower(id), revision, Profile{Title: "ok"}); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid revision accepted")
		}
	}
}

func TestRoutesAndBoundedModeSpecificFilters(t *testing.T) {
	id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	base := "/api/v1/clients/" + id + "/plans"
	for _, path := range []string{base, base + "/" + id, base + "/" + id + "/status", base + "/" + id + "/archive", base + "/" + id + "/task-candidates", base + "/" + id + "/milestones", base + "/" + id + "/milestones/" + id, base + "/" + id + "/milestones/" + id + "/task-links"} {
		if _, err := parseRoute(path); err != nil {
			t.Fatal("valid route rejected", path)
		}
	}
	for _, path := range []string{base + "/", base + "/bad", base + "/" + id + "/unknown", base + "/" + id + "/task-links", base + "/" + id + "/milestones/" + id + "/task-candidates", base + "/" + id + "/milestones/" + id + "/status/extra"} {
		if _, err := parseRoute(path); err == nil {
			t.Fatal("invalid route accepted", path)
		}
	}
	for _, input := range []struct {
		query, mode string
		milestone   bool
	}{{"?limit=0", "", false}, {"?limit=101", "", false}, {"?limit=1&limit=2", "", false}, {"?cursor=bad", "", false}, {"?status=planned", "", false}, {"?status=draft", "", true}, {"?sort=title", "", false}, {"?q=%00", "", false}, {"?q=x", "task-links", true}, {"?status=all", "task-links", true}, {"?archived=false", "task-candidates", false}, {"?other=x", "", false}, {"?q=", "", false}} {
		if _, err := parseFilter(httptest.NewRequest("GET", base+input.query, nil), input.milestone, input.mode); err == nil {
			t.Fatal("invalid query accepted", input.query)
		}
	}
	f, err := parseFilter(httptest.NewRequest("GET", base+"?limit=100&sort=-id&q=%E4%B8%96&archived=all&status=active", nil), false, "")
	if err != nil || f.Limit != 100 || f.Search != "世" {
		t.Fatal("valid filter rejected")
	}
}
