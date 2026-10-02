package reminders

import (
	"errors"
	"strings"
	"testing"
)

func TestReminderMetadataAndReferences(t *testing.T) {
	offset := 0
	p := Profile{Title: "  世 ", Description: " line\r\nnext ", OwnerID: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", ScheduledLocal: "2026-10-02T12:00:00", Timezone: "UTC", UTCOffsetSeconds: &offset}
	v, err := normalize(p)
	if err != nil || v.Title != "世" || v.Description != "line\nnext" || v.OwnerID != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" {
		t.Fatal("metadata normalization failed", err)
	}
	for _, change := range []func(*Profile){func(p *Profile) { p.Title = "" }, func(p *Profile) { p.Title = strings.Repeat("世", 201) }, func(p *Profile) { p.Description = "one\ttwo" }, func(p *Profile) { p.Description = strings.Repeat("a", 8001) }, func(p *Profile) { p.OwnerID = "" }, func(p *Profile) { p.Resource = &Resource{Kind: "client", ID: p.OwnerID} }, func(p *Profile) { p.Resource = &Resource{Kind: "task", ID: "bad"} }} {
		bad := p
		change(&bad)
		if _, err := normalize(bad); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid metadata accepted", err)
		}
	}
	for _, kind := range []string{"task", "plan", "milestone"} {
		p.Resource = &Resource{Kind: kind, ID: p.OwnerID}
		if _, err := normalize(p); err != nil {
			t.Fatal("supported resource rejected", err)
		}
	}
	p.UTCOffsetSeconds = nil
	if _, err := normalize(p); !errors.Is(err, ErrSchedule) {
		t.Fatal("required offset omitted")
	}
}
func TestReminderFiltersAndRoutes(t *testing.T) {
	f := Filter{Limit: 25, Status: "pending", Due: "all", Owner: "any", Sort: "id"}
	if !validFilter(f) {
		t.Fatal("default filter invalid")
	}
	for _, change := range []func(*Filter){func(f *Filter) { f.Limit = 101 }, func(f *Filter) { f.Cursor = "bad" }, func(f *Filter) { f.Status = "delivered" }, func(f *Filter) { f.Due = "notified" }, func(f *Filter) { f.Owner = "unassigned" }, func(f *Filter) { f.Search = "private\nquery" }, func(f *Filter) { f.Sort = "title" }} {
		bad := f
		change(&bad)
		if validFilter(bad) {
			t.Fatal("invalid filter accepted")
		}
	}
}
