package woocommerce

import (
	"encoding/json"
	"math/big"
	"sort"
	"strconv"

	"github.com/theroisey/else/backend/internal/integrations/providers/internal/jsonvalue"
)

// Product rows describe original lines in the order-created all-status cohort.
// They do not infer payment, inventory, refund-line allocation or recognized sales.
type Product struct {
	ProductID      string `json:"product_id"`
	VariationID    string `json:"variation_id"`
	Quantity       string `json:"quantity"`
	OrderCount     string `json:"order_count"`
	LineCount      string `json:"line_count"`
	TotalMinor     string `json:"total_minor"`
	TaxMinor       string `json:"tax_minor"`
	LineGrandMinor string `json:"line_grand_minor"`
}

type ProductReport struct {
	ClientID         string    `json:"client_id"`
	ConnectionID     string    `json:"connection_id"`
	APIVersion       string    `json:"api_version"`
	Currency         string    `json:"currency"`
	CurrencyExponent int       `json:"currency_exponent"`
	Start            string    `json:"start"`
	End              string    `json:"end"`
	Products         []Product `json:"products"`
}

type productGroup struct {
	product, variation   string
	quantity, total, tax *big.Int
	orders               map[string]bool
	lines                int
}

// NormalizeOrdersAndProducts accepts only a seven-field minimal order projection
// and bounded exact product lines. It preserves the earlier six-field contract
// by passing only unchanged source values to NormalizeOrders. Either both reports
// validate or neither is returned. IDs/names/customer data are never inferred.
func NormalizeOrdersAndProducts(e Expectation, pages []Page) (OrderReport, ProductReport, error) {
	exponent, ok := validExpectation(e)
	if !ok {
		return OrderReport{}, ProductReport{}, ErrUnavailable
	}
	rows, ok := completeRows(e, pages)
	if !ok {
		return OrderReport{}, ProductReport{}, ErrUnavailable
	}
	stripped := make([]Page, 0, len(pages))
	defer func() {
		for _, page := range stripped {
			clear(page.Body)
		}
	}()
	allLines := make([][]json.RawMessage, 0, len(rows))
	for _, page := range pages {
		original, _ := array(page.Body)
		projected := make([]map[string]json.RawMessage, 0, len(original))
		for _, raw := range original {
			fields, valid := jsonvalue.Object(raw, "id", "status", "currency", "date_created_gmt", "total", "refunds", "line_items")
			if !valid || len(fields) != 7 {
				return OrderReport{}, ProductReport{}, ErrUnavailable
			}
			lines, valid := array(fields["line_items"])
			if !valid || len(lines) > 50 {
				return OrderReport{}, ProductReport{}, ErrUnavailable
			}
			allLines = append(allLines, lines)
			delete(fields, "line_items")
			projected = append(projected, fields)
		}
		body, err := json.Marshal(projected)
		if err != nil {
			return OrderReport{}, ProductReport{}, ErrUnavailable
		}
		stripped = append(stripped, Page{Number: page.Number, Total: page.Total, TotalPages: page.TotalPages, Body: body})
	}
	orders, err := NormalizeOrders(e, stripped)
	if err != nil || len(orders.Orders) != len(allLines) {
		return OrderReport{}, ProductReport{}, ErrUnavailable
	}
	groups := map[string]*productGroup{}
	seen := map[string]bool{}
	for i, lines := range allLines {
		for _, raw := range lines {
			fields, valid := jsonvalue.Object(raw, "id", "product_id", "variation_id", "quantity", "total", "total_tax")
			if !valid || len(fields) != 6 {
				return OrderReport{}, ProductReport{}, ErrUnavailable
			}
			lineID, _, valid := integerID(fields["id"])
			if !valid || seen[lineID] {
				return OrderReport{}, ProductReport{}, ErrUnavailable
			}
			seen[lineID] = true
			productID, valid := productIDValue(fields["product_id"])
			if !valid {
				return OrderReport{}, ProductReport{}, ErrUnavailable
			}
			variationID, valid := productIDValue(fields["variation_id"])
			if !valid {
				return OrderReport{}, ProductReport{}, ErrUnavailable
			}
			quantity, _, valid := integerID(fields["quantity"])
			if !valid {
				return OrderReport{}, ProductReport{}, ErrUnavailable
			}
			total, valid := text(fields["total"])
			if !valid {
				return OrderReport{}, ProductReport{}, ErrUnavailable
			}
			tax, valid := text(fields["total_tax"])
			if !valid {
				return OrderReport{}, ProductReport{}, ErrUnavailable
			}
			net, valid := minor(total, exponent)
			if !valid {
				return OrderReport{}, ProductReport{}, ErrUnavailable
			}
			taxValue, valid := minor(tax, exponent)
			if !valid {
				return OrderReport{}, ProductReport{}, ErrUnavailable
			}
			key := productID + ":" + variationID
			group := groups[key]
			if group == nil {
				if len(groups) >= 1000 {
					return OrderReport{}, ProductReport{}, ErrUnavailable
				}
				group = &productGroup{product: productID, variation: variationID, quantity: new(big.Int), total: new(big.Int), tax: new(big.Int), orders: map[string]bool{}}
				groups[key] = group
			}
			q, _ := new(big.Int).SetString(quantity, 10)
			group.quantity.Add(group.quantity, q)
			group.total.Add(group.total, net)
			group.tax.Add(group.tax, taxValue)
			group.orders[orders.Orders[i].ID] = true
			group.lines++
		}
	}
	report := ProductReport{ClientID: e.ClientID, ConnectionID: e.ConnectionID, APIVersion: APIVersion, Currency: e.Currency, CurrencyExponent: exponent, Start: e.Start, End: e.End, Products: make([]Product, 0, len(groups))}
	for _, group := range groups {
		report.Products = append(report.Products, Product{ProductID: group.product, VariationID: group.variation, Quantity: group.quantity.String(), OrderCount: strconv.Itoa(len(group.orders)), LineCount: strconv.Itoa(group.lines), TotalMinor: group.total.String(), TaxMinor: group.tax.String(), LineGrandMinor: new(big.Int).Add(group.total, group.tax).String()})
	}
	sort.Slice(report.Products, func(i, j int) bool {
		a, b := report.Products[i], report.Products[j]
		if a.ProductID != b.ProductID {
			return numericIDLess(a.ProductID, b.ProductID)
		}
		return numericIDLess(a.VariationID, b.VariationID)
	})
	return orders, report, nil
}

func productIDValue(raw []byte) (string, bool) {
	if string(raw) == "0" {
		return "0", true
	}
	id, _, valid := integerID(raw)
	return id, valid
}
func numericIDLess(a, b string) bool {
	x, _ := strconv.ParseInt(a, 10, 64)
	y, _ := strconv.ParseInt(b, 10, 64)
	return x < y
}
