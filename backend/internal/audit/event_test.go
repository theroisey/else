package audit

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
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

func TestErrorRetainsCauseWithoutExposingIt(t *testing.T) {
	cause := errors.New("password=secret")
	err := &Error{Operation: "audit insert", cause: cause}
	if strings.Contains(err.Error(), "secret") || !errors.Is(err, cause) {
		t.Fatal("unsafe or lost error cause")
	}
}
