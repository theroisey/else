package woocommerce

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func storedFixture(t *testing.T) Workspace {
	t.Helper()
	a, key, _ := collectorFixture(t, 2, 2)
	w, err := a.Fetch(context.Background(), key, expectation())
	if err != nil {
		t.Fatal("synthetic collection unavailable")
	}
	return w
}

func TestStoredWorkspaceBindingsArithmeticBoundsAndPrivateFieldRejection(t *testing.T) {
	w := storedFixture(t)
	raw, _ := json.Marshal(w)
	decoded, err := DecodeWorkspace(raw, expectation())
	if err != nil || !reflect.DeepEqual(w, decoded) {
		t.Fatal("stored workspace round trip failed")
	}
	mutations := []func(*Workspace){
		func(w *Workspace) { w.Orders.ClientID = "private client" },
		func(w *Workspace) { w.Refunds.ConnectionID = "private connection" },
		func(w *Workspace) { w.Products.Currency = "TRY" },
		func(w *Workspace) { w.Orders.CurrencyExponent = 0 },
		func(w *Workspace) { w.Products.End = "2026-10-02T00:00:01Z" },
		func(w *Workspace) { w.Orders.GrandTotalMinor = "0" },
		func(w *Workspace) { w.Orders.Orders[0].RemainderMinor = "9999" },
		func(w *Workspace) { w.Orders.Orders[0].GrandTotalMinor = "010000" },
		func(w *Workspace) { w.Orders.Orders[0].LifetimeRefundMinor = "10001" },
		func(w *Workspace) { w.Orders.Orders[0].CreatedAt = expectation().End },
		func(w *Workspace) { w.Orders.Orders[0].CreatedAt = "2026-10-01T00:00:00+00:00" },
		func(w *Workspace) { w.Orders.Orders[1].ID = w.Orders.Orders[0].ID },
		func(w *Workspace) { w.Refunds.Refunds[0].ID = w.Orders.Orders[0].ID },
		func(w *Workspace) { w.Refunds.AmountMinor = "1" },
		func(w *Workspace) { w.Refunds.Refunds[0].ParentID = w.Refunds.Refunds[0].ID },
		func(w *Workspace) { w.Refunds.Refunds[0].AmountMinor = "-100" },
		func(w *Workspace) { w.Products.Products[0].LineGrandMinor = "19999" },
		func(w *Workspace) { w.Products.Products[0].Quantity = "1" },
		func(w *Workspace) { w.Products.Products[0].Quantity = "99999999999999999999999" },
		func(w *Workspace) {
			w.Products.Products[0].TotalMinor = "99999999999999999999999"
			w.Products.Products[0].LineGrandMinor = "100000000000000000001999"
		},
		func(w *Workspace) { w.Products.Products[0].OrderCount = "3" },
		func(w *Workspace) { w.Products.Products[0].LineCount = "101" },
		func(w *Workspace) { w.Products.Products = append(w.Products.Products, w.Products.Products[0]) },
		func(w *Workspace) { w.Orders.Orders = nil },
		func(w *Workspace) { w.Refunds.Refunds = nil },
		func(w *Workspace) { w.Products.Products = nil },
		func(w *Workspace) { w.CollectedFrom = time.Time{} },
		func(w *Workspace) { w.CollectedThrough = w.CollectedFrom.Add(-time.Microsecond) },
		func(w *Workspace) { w.CollectedThrough = w.CollectedFrom.Add(122 * time.Second) },
		func(w *Workspace) { w.CollectedFrom = w.CollectedFrom.Add(time.Nanosecond) },
	}
	for i, mutate := range mutations {
		var copy Workspace
		_ = json.Unmarshal(raw, &copy)
		mutate(&copy)
		if ValidWorkspace(copy, expectation()) {
			t.Fatalf("invalid normalized workspace accepted at mutation %d", i)
		}
	}
	for _, changed := range []string{
		strings.Replace(string(raw), `"orders":{`, `"orders":{"customer_email":"private",`, 1),
		strings.Replace(string(raw), `"products":[{`, `"products":[{"name":"private",`, 1),
		strings.Replace(string(raw), `"refunds":[{`, `"refunds":[{"reason":"private",`, 1),
		strings.Replace(string(raw), `"orders":[{`, `"orders":[{"billing":{},`, 1),
		strings.Replace(string(raw), `"collected_from":`, `"consumer_secret":"private","collected_from":`, 1),
		strings.Replace(string(raw), `"quantity":"4"`, `"quantity":"4","quantit\u0079":"4"`, 1),
		strings.Replace(string(raw), `"currency":"USD"`, `"currency":null`, 1),
		strings.Replace(string(raw), `"collected_from":`, `"collected_from":"2026-10-04T12:00:00Z","collected_from":`, 1),
	} {
		if changed == string(raw) {
			t.Fatal("mutation did not change fixture")
		}
		got, err := DecodeWorkspace([]byte(changed), expectation())
		if err != ErrUnavailable || !reflect.DeepEqual(got, Workspace{}) {
			t.Fatal("expanded or duplicate stored JSON accepted")
		}
	}
}

func TestStoredEmptyWorkspaceAndLargeExactProductQuantities(t *testing.T) {
	a, key, _ := collectorFixture(t, 0, 0)
	w, err := a.Fetch(context.Background(), key, expectation())
	if err != nil || !ValidWorkspace(w, expectation()) {
		t.Fatal("complete empty workspace rejected")
	}
	a, key, f := collectorFixture(t, 2, 0)
	for _, row := range f.orderRows {
		line := row["line_items"].([]any)[0].(map[string]any)
		line["quantity"] = json.Number("9007199254740993")
	}
	w, err = a.Fetch(context.Background(), key, expectation())
	if err != nil || !ValidWorkspace(w, expectation()) || w.Products.Products[0].Quantity != "18014398509481986" {
		t.Fatal("large exact product count rejected")
	}
}

func TestStoredWorkspaceRejectsNullZeroPlaceExponentAndNoncanonicalCollectionTimes(t *testing.T) {
	w := storedFixture(t)
	e := expectation()
	e.Currency = "JPY"
	w.Orders.Currency, w.Refunds.Currency, w.Products.Currency = "JPY", "JPY", "JPY"
	w.Orders.CurrencyExponent, w.Refunds.CurrencyExponent, w.Products.CurrencyExponent = 0, 0, 0
	raw, _ := json.Marshal(w)
	if _, err := DecodeWorkspace(raw, e); err != nil {
		t.Fatal("valid JPY workspace rejected")
	}
	for _, changed := range []string{
		strings.Replace(string(raw), `"currency_exponent":0`, `"currency_exponent":null`, 1),
		strings.Replace(string(raw), `"collected_from":"2026-10-04T12:00:00Z"`, `"collected_from":"2026-10-04T12:00:00.000000Z"`, 1),
	} {
		if changed == string(raw) {
			t.Fatal("fixture mutation did not change source")
		}
		if _, err := DecodeWorkspace([]byte(changed), e); err != ErrUnavailable {
			t.Fatal("null exponent or noncanonical collection stamp accepted")
		}
	}
}
