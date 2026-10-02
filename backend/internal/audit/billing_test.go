package audit

import (
	"errors"
	"testing"
)

func TestBillingActionsAndTypedMonetarySnapshotsAreBounded(t *testing.T) {
	state, currency, total, paid := "partially_paid", "JPY", "9223372036854775807", "9007199254740993"
	e := validEvent()
	e.ResourceKind = "billing"
	e.After = &Snapshot{BillingStatus: &state, Currency: &currency, AmountMinor: &total, PaidMinor: &paid}
	for _, action := range []Action{Created, Updated, PaymentRecorded, Cancelled} {
		e.Action = action
		if _, _, _, err := e.encode(); err != nil {
			t.Fatal(action, err)
		}
	}
	for _, mutate := range []func(*Event){func(e *Event) { e.ResourceKind = "client" }, func(e *Event) { e.Action = Deleted }, func(e *Event) { e.After.AmountMinor = nil }, func(e *Event) { v := "9223372036854775808"; e.After.AmountMinor = &v }, func(e *Event) { v := "01"; e.After.PaidMinor = &v }, func(e *Event) { v := "XXX"; e.After.Currency = &v }, func(e *Event) { v := "refunded"; e.After.BillingStatus = &v }} {
		copy := e
		copy.Action = Updated
		s := *e.After
		copy.After = &s
		mutate(&copy)
		if _, _, _, err := copy.encode(); !errors.Is(err, ErrInvalidEvent) {
			t.Fatal("unsafe financial snapshot accepted", err)
		}
	}
}
