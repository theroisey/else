package billing

import "testing"

func TestExactCanonicalAmountsDatesAndCurrencyInputs(t *testing.T) {
	for _, value := range []string{"1", "9007199254740993", "9223372036854775807"} {
		if _, e := integer(value); e != nil {
			t.Fatal(value, e)
		}
	}
	for _, value := range []string{"", "0", "-1", "+1", "01", "1.0", "1e2", " 1", "9223372036854775808", "99999999999999999999"} {
		if _, e := integer(value); e == nil {
			t.Fatal("accepted inexact amount", value)
		}
	}
	for _, value := range []string{"0001-01-01", "2024-02-29", "9999-12-31"} {
		if !validDate(value) {
			t.Fatal(value)
		}
	}
	for _, value := range []string{"0000-01-01", "2026-02-29", "2026-02-30", "2026-1-01", "2026-01-01T00:00:00Z"} {
		if validDate(value) {
			t.Fatal("accepted invalid date", value)
		}
	}
	for _, currency := range []string{"USD", "EUR", "GBP", "TRY", "JPY", "KWD"} {
		if !validCurrency(currency) {
			t.Fatal(currency)
		}
	}
	for _, currency := range []string{"usd", " USD", "XXX", "BTC", ""} {
		if validCurrency(currency) {
			t.Fatal("accepted unreviewed currency", currency)
		}
	}
}
