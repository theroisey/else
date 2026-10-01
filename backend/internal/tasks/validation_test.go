package tasks

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProfileNormalizationAndValidation(t *testing.T) {
	start := time.Date(2026, 10, 1, 9, 0, 0, 0, time.FixedZone("fixture", 2*3600))
	due := start.Add(time.Hour)
	input := Profile{Title: "  Synthetic task  ", Description: " one\r\ntwo ", Tags: []string{" Urgent "}, StartAt: &start, DueAt: &due}
	p, err := normalize(input)
	if err != nil || p.Title != "Synthetic task" || p.Description != "one\ntwo" || p.Priority != "medium" || p.Tags[0] != "urgent" || p.StartAt.Location() != time.UTC || !p.StartAt.Equal(start) || input.Tags[0] != " Urgent " {
		t.Fatal("normalization failed", err)
	}
	for _, alter := range []func(*Profile){
		func(p *Profile) { p.Title = " " }, func(p *Profile) { p.Title = strings.Repeat("界", 201) }, func(p *Profile) { p.Title = "bad\nname" },
		func(p *Profile) { p.Description = "bad\ttext" }, func(p *Profile) { p.Description = strings.Repeat("x", 8001) }, func(p *Profile) { p.Priority = "critical" },
		func(p *Profile) { v := "bad"; p.AssigneeID = &v }, func(p *Profile) { p.StartAt = &due; p.DueAt = &start },
		func(p *Profile) { v := time.Date(1, 1, 1, 0, 0, 0, 0, time.FixedZone("fixture", 3600)); p.StartAt = &v },
		func(p *Profile) { p.Tags = []string{"same", " SAME "} }, func(p *Profile) { p.Tags = make([]string, 21) }, func(p *Profile) { p.Tags = []string{""} },
	} {
		bad := input
		alter(&bad)
		if _, err := normalize(bad); err == nil {
			t.Fatal("invalid profile accepted")
		}
	}
}
func TestStrictBoundedQueries(t *testing.T) {
	for _, q := range []string{"limit=0", "limit=101", "limit=1&limit=2", "cursor=bad", "status=deleted", "priority=critical", "assignee=bad", "sort=title", "archived=yes", "unknown=x", "q=", "tag=" + strings.Repeat("x", 41), "q=" + strings.Repeat("x", 101), "q=%zz"} {
		if _, err := parseFilter(httptest.NewRequest("GET", "/tasks?"+q, nil), false); err == nil {
			t.Fatalf("accepted query %q", q)
		}
	}
	f, err := parseFilter(httptest.NewRequest("GET", "/tasks?status=done&priority=urgent&assignee=unassigned&archived=all&sort=-id&tag=WORK", nil), false)
	if err != nil || f.Tag != "work" || f.Limit != 25 {
		t.Fatal("valid filters rejected", err)
	}
	if _, err := parseFilter(httptest.NewRequest("GET", "/assignees?status=done", nil), true); err == nil {
		t.Fatal("candidate query allowed task filters")
	}
}
func TestStrictBoundedBodies(t *testing.T) {
	for _, body := range []string{`{"title":"ok","status":"done","created_by":"forged"}`, `{"title":"ok"} {}`, `{"title":"ok","start_at":"2026-10-01T09:00:00"}`, `{"title":"` + strings.Repeat("x", 65536) + `"}`} {
		var input CreateInput
		w := httptest.NewRecorder()
		if decode(w, httptest.NewRequest("POST", "/tasks", strings.NewReader(body)), &input) || w.Code != 400 {
			t.Fatal("unsafe body accepted")
		}
	}
}
