package woocommerce

import (
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestProductCohortCurrencyPrecisionUnknownProductsAndDistinctBound(t *testing.T) {
	for _, tc := range []struct {
		currency, total, tax, grand, want string
		exponent                          int
	}{
		{"JPY", "9007199254740993.000000", "1.000000", "9007199254740994.000000", "9007199254740994", 0},
		{"KWD", "1.234000", "0.001000", "1.235000", "1235", 3},
	} {
		e := expectation()
		e.Currency = tc.currency
		raw := strings.Replace(order, `"USD"`, `"`+tc.currency+`"`, 1)
		raw = strings.Replace(raw, `100.010000`, tc.grand, 1)
		raw = strings.Replace(raw, `-1.010000`, `-0.000000`, 1)
		line := strings.Replace(productLine, `90.000000`, tc.total, 1)
		line = strings.Replace(line, `10.010000`, tc.tax, 1)
		_, products, err := NormalizeOrdersAndProducts(e, page(withProducts(raw, "["+line+"]")))
		if err != nil || products.CurrencyExponent != tc.exponent || products.Products[0].LineGrandMinor != tc.want {
			t.Fatal("zero/three-place product precision changed")
		}
	}
	line := strings.Replace(productLine, `"product_id":3`, `"product_id":0`, 1)
	_, products, err := NormalizeOrdersAndProducts(expectation(), page(withProducts(order, "["+line+"]")))
	if err != nil || products.Products[0].ProductID != "0" {
		t.Fatal("unknown product inferred/dropped")
	}
	for _, groups := range []int{1000, 1001} {
		orderCount := (groups + 2) / 3
		_, _, fixture := collectorFixture(t, orderCount, 0)
		id := 1
		for _, row := range fixture.orderRows {
			lines := []any{}
			for n := 0; n < 3 && id <= groups; n++ {
				lines = append(lines, map[string]any{"id": 10000 + id, "product_id": id, "variation_id": 0, "quantity": 1, "total": "1.000000", "total_tax": "0.000000"})
				id++
			}
			row["line_items"] = lines
		}
		pages := []Page{}
		for offset := 0; offset < orderCount; offset += 100 {
			body, _ := json.Marshal(fixture.orderRows[offset:min(offset+100, orderCount)])
			pages = append(pages, Page{Number: len(pages) + 1, Total: strconv.Itoa(orderCount), TotalPages: strconv.Itoa((orderCount + 99) / 100), Body: body})
		}
		a, b, err := NormalizeOrdersAndProducts(expectation(), pages)
		if groups == 1000 {
			if err != nil || len(b.Products) != 1000 || b.Products[9].ProductID != "10" {
				t.Fatal("complete maximum product grouping/sort failed")
			}
		} else if err != ErrUnavailable || !reflect.DeepEqual(a, OrderReport{}) || !reflect.DeepEqual(b, ProductReport{}) {
			t.Fatal("oversized product group published")
		}
	}
}

const productLine = `{"id":100,"product_id":3,"variation_id":0,"quantity":2,"total":"90.000000","total_tax":"10.010000"}`

func withProducts(raw, lines string) string {
	return strings.TrimSuffix(raw, "}") + `,"line_items":` + lines + `}`
}

func TestProductCohortExactGroupingAndLegacyBoundary(t *testing.T) {
	raw := withProducts(order, "["+productLine+"]")
	orders, products, err := NormalizeOrdersAndProducts(expectation(), page(raw))
	if err != nil || orders.GrandTotalMinor != "10001" || len(products.Products) != 1 || products.Products[0] != (Product{ProductID: "3", VariationID: "0", Quantity: "2", OrderCount: "1", LineCount: "1", TotalMinor: "9000", TaxMinor: "1001", LineGrandMinor: "10001"}) {
		t.Fatal("exact observed product grouping differs")
	}
	if _, err := NormalizeOrders(expectation(), page(raw)); err != ErrUnavailable {
		t.Fatal("legacy six-field contract widened")
	}
	encoded, err := json.Marshal(products)
	if err != nil || !strings.Contains(string(encoded), `"client_id":"`+expectation().ClientID+`"`) || strings.Contains(string(encoded), "ClientID") {
		t.Fatal("product DTO binding projection differs")
	}
	second := strings.Replace(order, `"id":1`, `"id":2`, 1)
	second = strings.Replace(second, `{"id":10,"total":"-1.010000"}`, `{"id":11,"total":"-1.010000"}`, 1)
	secondLine := strings.Replace(productLine, `"id":100`, `"id":101`, 1)
	secondLine = strings.Replace(secondLine, `"quantity":2`, `"quantity":9007199254740993`, 1)
	pages := []Page{{Number: 1, Total: "2", TotalPages: "1", Body: []byte("[" + raw + "," + withProducts(second, "["+secondLine+"]") + "]")}}
	_, products, err = NormalizeOrdersAndProducts(expectation(), pages)
	if err != nil || products.Products[0].Quantity != "9007199254740995" || products.Products[0].OrderCount != "2" || products.Products[0].LineCount != "2" || products.Products[0].LineGrandMinor != "20002" {
		t.Fatal("exact quantities/order-count grouping differs")
	}
	empty := []Page{{Number: 1, Total: "0", TotalPages: "0", Body: []byte("[]")}}
	orders, products, err = NormalizeOrdersAndProducts(expectation(), empty)
	if err != nil || orders.Orders == nil || products.Products == nil || len(products.Products) != 0 {
		t.Fatal("empty cohort fabricated observations")
	}
}

func TestProductCohortRejectsPrivateExpandedInexactAndDuplicateLinesAtomically(t *testing.T) {
	for _, line := range []string{
		strings.Replace(productLine, `"quantity":2`, `"quantity":2.5`, 1),
		strings.Replace(productLine, `"quantity":2`, `"quantity":-1`, 1),
		strings.Replace(productLine, `"product_id":3`, `"product_id":"3"`, 1),
		strings.Replace(productLine, `"90.000000"`, `"90.001000"`, 1),
		strings.Replace(productLine, `"90.000000"`, `"-90.000000"`, 1),
		strings.Replace(productLine, `}`, `,"name":"Synthetic private customer customization"}`, 1),
		strings.Replace(productLine, `"total_tax"`, `"total_tax":null,"total_t\u0061x"`, 1),
	} {
		a, b, err := NormalizeOrdersAndProducts(expectation(), page(withProducts(order, "["+line+"]")))
		if err != ErrUnavailable || !reflect.DeepEqual(a, OrderReport{}) || !reflect.DeepEqual(b, ProductReport{}) {
			t.Fatal("invalid lines returned partial report")
		}
	}
	for _, lines := range []string{"null", "{}", "[" + productLine + "," + productLine + "]", "[" + strings.Repeat(productLine+",", 50) + productLine + "]"} {
		a, b, err := NormalizeOrdersAndProducts(expectation(), page(withProducts(order, lines)))
		if err != ErrUnavailable || !reflect.DeepEqual(a, OrderReport{}) || !reflect.DeepEqual(b, ProductReport{}) {
			t.Fatal("duplicate/oversized/private product lines published")
		}
	}
}
