package audit

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func validEvent() Event {
	return Event{Actor: Actor{Kind: System}, Action: Updated, ResourceKind: "fixture",
		ResourceID: "11111111-1111-4111-8111-111111111111", Metadata: Metadata{Source: CLI}}
}

func TestPayloadAllowlistExcludesRawInput(t *testing.T) {
	// Decode an attacker-shaped DTO only to demonstrate that even accidental
	// decoding into these types cannot retain unapproved keys or nested secrets.
	var snapshot Snapshot
	if err := json.Unmarshal([]byte(`{"exists":true,"password":"secret","token":"secret","nested":{"secret":"secret"}}`), &snapshot); err != nil {
		t.Fatal(err)
	}
	event := validEvent()
	event.After = &snapshot
	before, after, metadata, err := event.encode()
	if err != nil || string(before) != "null" || string(after) != `{"exists":true}` || string(metadata) != `{"source":"cli"}` {
		t.Fatalf("unexpected safe serialization: %s %s %s %v", before, after, metadata, err)
	}
}

func TestInvalidEventsAreRejected(t *testing.T) {
	negative := int64(-1)
	for name, change := range map[string]func(*Event){
		"actor spoof":       func(e *Event) { e.Actor.UserID = e.ResourceID },
		"missing user":      func(e *Event) { e.Actor.Kind = User },
		"unknown actor":     func(e *Event) { e.Actor.Kind = "anonymous" },
		"zero resource":     func(e *Event) { e.ResourceID = "00000000-0000-0000-0000-000000000000" },
		"invalid resource":  func(e *Event) { e.ResourceID = "secret" },
		"invalid client":    func(e *Event) { e.ClientID = "secret" },
		"long kind":         func(e *Event) { e.ResourceKind = strings.Repeat("a", 33) },
		"untrusted kind":    func(e *Event) { e.ResourceKind = "secret\n" },
		"action":            func(e *Event) { e.Action = "token=secret" },
		"source":            func(e *Event) { e.Metadata.Source = "secret" },
		"negative revision": func(e *Event) { e.Before = &Snapshot{Revision: &negative} },
	} {
		t.Run(name, func(t *testing.T) {
			e := validEvent()
			change(&e)
			_, _, _, err := e.encode()
			if !errors.Is(err, ErrInvalidEvent) {
				t.Fatal("invalid event accepted")
			}
		})
	}
}

func TestTransactionRequiresCorrelationBeforeMutation(t *testing.T) {
	called := false
	err := WithTransaction(context.Background(), nil, func(context.Context, Queries) (Event, error) { called = true; return validEvent(), nil })
	if !errors.Is(err, ErrMissingCorrelation) || called {
		t.Fatal("uncorrelated mutation allowed")
	}
}

func TestReminderSchedulingSnapshotsAndActionsStayResourceBound(t *testing.T) {
	state := "pending"
	zone := "America/New_York"
	scheduled := time.Date(2026, 11, 1, 6, 30, 0, 123456000, time.UTC)
	base := validEvent()
	base.ResourceKind = "reminder"
	base.After = &Snapshot{ReminderStatus: &state, ReminderScheduledAt: &scheduled, ReminderTimezone: &zone}
	for _, action := range []Action{Created, Updated, Completed, Dismissed} {
		e := base
		e.Action = action
		if _, _, _, err := e.encode(); err != nil {
			t.Fatal("valid reminder audit rejected", err)
		}
	}
	for _, change := range []func(*Event){
		func(e *Event) { e.ResourceKind = "client" }, func(e *Event) { e.Action = Cancelled }, func(e *Event) { e.Action = Archived },
		func(e *Event) { v := "delivered"; e.After.ReminderStatus = &v }, func(e *Event) { e.After.ReminderTimezone = nil }, func(e *Event) { e.After.ReminderScheduledAt = nil },
		func(e *Event) { v := "Local"; e.After.ReminderTimezone = &v }, func(e *Event) { v := "Unknown/Zone"; e.After.ReminderTimezone = &v },
		func(e *Event) { v := scheduled.Add(time.Nanosecond); e.After.ReminderScheduledAt = &v },
		func(e *Event) { v := scheduled.In(time.FixedZone("unsafe", 3600)); e.After.ReminderScheduledAt = &v },
		func(e *Event) { v := time.Time{}; v = v.AddDate(-1, 0, 0); e.After.ReminderScheduledAt = &v },
	} {
		e := base
		snapshot := *base.After
		e.After = &snapshot
		change(&e)
		if _, _, _, err := e.encode(); !errors.Is(err, ErrInvalidEvent) {
			t.Fatal("invalid reminder audit accepted", err)
		}
	}
	e := base
	e.ResourceKind = "task"
	e.After = nil
	e.Action = Dismissed
	if _, _, _, err := e.encode(); !errors.Is(err, ErrInvalidEvent) {
		t.Fatal("reminder action applied to task")
	}
}

func TestAdministrationActionsAndStatusAreAllowlisted(t *testing.T) {
	status := "disabled"
	for _, input := range []struct {
		kind   string
		action Action
	}{{"user", Disabled}, {"role", PermissionChanged}} {
		e := validEvent()
		e.ResourceKind, e.Action = input.kind, input.action
		e.After = &Snapshot{Status: &status}
		if _, _, _, err := e.encode(); err != nil {
			t.Fatal("typed administration event rejected", err)
		}
		e.ResourceKind = "fixture"
		if _, _, _, err := e.encode(); !errors.Is(err, ErrInvalidEvent) {
			t.Fatal("administration action applied to wrong resource")
		}
	}
	status = "password=secret"
	e := validEvent()
	e.After = &Snapshot{Status: &status}
	if _, _, _, err := e.encode(); !errors.Is(err, ErrInvalidEvent) {
		t.Fatal("untrusted account status accepted")
	}
}

func TestErrorRetainsCauseWithoutExposingIt(t *testing.T) {
	cause := errors.New("password=secret")
	err := &Error{Operation: "audit insert", cause: cause}
	if strings.Contains(err.Error(), "secret") || !errors.Is(err, cause) {
		t.Fatal("unsafe or lost error cause")
	}
}

func TestTaskActionsAndStateAreResourceBound(t *testing.T) {
	for _, action := range []Action{Created, Updated, Completed, Cancelled, Archived} {
		for _, status := range []string{"backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled"} {
			e := validEvent()
			e.ResourceKind = "task"
			e.Action = action
			e.After = &Snapshot{TaskStatus: &status}
			if _, _, _, err := e.encode(); err != nil {
				t.Fatal("task audit rejected", err)
			}
			e.ResourceKind = "client"
			if _, _, _, err := e.encode(); !errors.Is(err, ErrInvalidEvent) {
				t.Fatal("task audit escaped its resource kind")
			}
		}
	}
	status := "secret=untrusted"
	e := validEvent()
	e.ResourceKind = "task"
	e.After = &Snapshot{TaskStatus: &status}
	if _, _, _, err := e.encode(); !errors.Is(err, ErrInvalidEvent) {
		t.Fatal("untrusted task state accepted")
	}
}

func TestPlanningStateIsBoundToPlanOrMilestone(t *testing.T) {
	for _, kind := range []string{"plan", "milestone", "client", "task"} {
		for _, status := range []string{"draft", "active", "planned", "in_progress", "completed", "cancelled", "secret", ""} {
			e := validEvent()
			e.ResourceKind = kind
			e.After = &Snapshot{PlanningStatus: &status}
			_, _, _, err := e.encode()
			valid := (kind == "plan" && (status == "draft" || status == "active" || status == "completed" || status == "cancelled")) || (kind == "milestone" && (status == "planned" || status == "in_progress" || status == "completed" || status == "cancelled"))
			if (err == nil) != valid {
				t.Fatal("planning audit resource boundary failed", kind, status)
			}
		}
	}
}
