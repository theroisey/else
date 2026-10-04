package woocommerce

import (
	"encoding/json"
	"math/big"
	"regexp"
	"strconv"
	"time"

	"github.com/theroisey/else/backend/internal/integrations/providers/internal/jsonvalue"
)

var aggregate = regexp.MustCompile(`^(0|[1-9][0-9]{0,23})$`)

// ValidExpectation verifies the compiled collector's binding and period bounds.
func ValidExpectation(e Expectation) bool {
	_, ok := validExpectation(e)
	return ok && e.PerPage == 100
}

// ValidWorkspace checks a complete normalized report before storage or display.
// This verifies bounds and reconciliation, not store ownership or a transactional
// provider snapshot. Different order-created/refund-created cohorts stay separate.
func ValidWorkspace(w Workspace, e Expectation) bool {
	exponent, ok := validExpectation(e)
	if !ok || e.PerPage != 100 || w.CollectedFrom.IsZero() || w.CollectedThrough.IsZero() ||
		w.CollectedFrom.Location() != time.UTC || w.CollectedThrough.Location() != time.UTC ||
		w.CollectedFrom.Year() < 2000 || w.CollectedThrough.Year() >= 10000 ||
		w.CollectedFrom.Nanosecond()%1000 != 0 || w.CollectedThrough.Nanosecond()%1000 != 0 ||
		w.CollectedThrough.Before(w.CollectedFrom) || w.CollectedThrough.Sub(w.CollectedFrom) > 121*time.Second {
		return false
	}
	for _, binding := range []struct {
		client, connection, version, currency, start, end string
		exponent                                          int
	}{
		{w.Orders.ClientID, w.Orders.ConnectionID, w.Orders.APIVersion, w.Orders.Currency, w.Orders.Start, w.Orders.End, w.Orders.CurrencyExponent},
		{w.Refunds.ClientID, w.Refunds.ConnectionID, w.Refunds.APIVersion, w.Refunds.Currency, w.Refunds.Start, w.Refunds.End, w.Refunds.CurrencyExponent},
		{w.Products.ClientID, w.Products.ConnectionID, w.Products.APIVersion, w.Products.Currency, w.Products.Start, w.Products.End, w.Products.CurrencyExponent},
	} {
		if binding.client != e.ClientID || binding.connection != e.ConnectionID || binding.version != APIVersion || binding.currency != e.Currency || binding.start != e.Start || binding.end != e.End || binding.exponent != exponent {
			return false
		}
	}
	if w.Orders.Orders == nil || w.Refunds.Refunds == nil || w.Products.Products == nil || len(w.Orders.Orders) > 500 || len(w.Refunds.Refunds) > 500 || len(w.Products.Products) > 1000 {
		return false
	}
	grand, refunded, remaining, events := new(big.Int), new(big.Int), new(big.Int), new(big.Int)
	previous := "0"
	orderIDs := make(map[string]bool, len(w.Orders.Orders))
	for _, row := range w.Orders.Orders {
		if !id.MatchString(row.ID) || !numericIDLess(previous, row.ID) || !knownStatus(row.Status) || !workspaceDate(row.CreatedAt, e) || !boundedInteger(row.GrandTotalMinor, 18) || !boundedInteger(row.LifetimeRefundMinor, 20) || !boundedInteger(row.RemainderMinor, 18) || !exactSum(row.GrandTotalMinor, row.LifetimeRefundMinor, row.RemainderMinor) {
			return false
		}
		previous = row.ID
		orderIDs[row.ID] = true
		addExact(grand, row.GrandTotalMinor)
		addExact(refunded, row.LifetimeRefundMinor)
		addExact(remaining, row.RemainderMinor)
	}
	if grand.String() != w.Orders.GrandTotalMinor || refunded.String() != w.Orders.LifetimeRefundMinor || remaining.String() != w.Orders.RemainderMinor {
		return false
	}
	previous = "0"
	for _, row := range w.Refunds.Refunds {
		if !id.MatchString(row.ID) || !numericIDLess(previous, row.ID) || !id.MatchString(row.ParentID) || row.ID == row.ParentID || orderIDs[row.ID] || !workspaceDate(row.CreatedAt, e) || !boundedInteger(row.AmountMinor, 18) {
			return false
		}
		previous = row.ID
		addExact(events, row.AmountMinor)
	}
	if events.String() != w.Refunds.AmountMinor {
		return false
	}
	previousProduct, previousVariation := "", ""
	totalLines := 0
	for _, row := range w.Products.Products {
		if (row.ProductID != "0" && !id.MatchString(row.ProductID)) || (row.VariationID != "0" && !id.MatchString(row.VariationID)) ||
			(previousProduct != "" && (!numericIDLess(previousProduct, row.ProductID) && (previousProduct != row.ProductID || !numericIDLess(previousVariation, row.VariationID)))) ||
			!boundedInteger(row.Quantity, 23) || row.Quantity == "0" || !boundedInteger(row.OrderCount, 3) || !boundedInteger(row.LineCount, 5) ||
			!boundedInteger(row.TotalMinor, 23) || !boundedInteger(row.TaxMinor, 23) || !boundedInteger(row.LineGrandMinor, 23) || !exactSum(row.LineGrandMinor, row.TotalMinor, row.TaxMinor) {
			return false
		}
		orders, _ := strconv.Atoi(row.OrderCount)
		lines, _ := strconv.Atoi(row.LineCount)
		quantity, _ := new(big.Int).SetString(row.Quantity, 10)
		if orders < 1 || orders > len(w.Orders.Orders) || lines < orders || lines > orders*50 || quantity.Cmp(big.NewInt(int64(lines))) < 0 {
			return false
		}
		limit := new(big.Int).Mul(big.NewInt(int64(lines)), big.NewInt(999999999999999999))
		for _, amount := range []string{row.Quantity, row.TotalMinor, row.TaxMinor} {
			number, _ := new(big.Int).SetString(amount, 10)
			if number.Cmp(limit) > 0 {
				return false
			}
		}
		totalLines += lines
		previousProduct, previousVariation = row.ProductID, row.VariationID
	}
	return totalLines <= len(w.Orders.Orders)*50
}

func boundedInteger(value string, digits int) bool {
	return len(value) <= digits && aggregate.MatchString(value)
}
func addExact(sum *big.Int, value string) {
	number, _ := new(big.Int).SetString(value, 10)
	sum.Add(sum, number)
}
func exactSum(total, first, second string) bool {
	a, _ := new(big.Int).SetString(first, 10)
	b, _ := new(big.Int).SetString(second, 10)
	return a.Add(a, b).String() == total
}
func workspaceDate(value string, e Expectation) bool {
	t, err := time.Parse(time.RFC3339, value)
	return err == nil && t.UTC().Format(time.RFC3339) == value && value >= e.Start && value < e.End
}

// DecodeWorkspace rejects unknown, missing or duplicate keys at every level.
// In particular, permissive struct decoding must not hide private provider data.
func DecodeWorkspace(raw []byte, e Expectation) (Workspace, error) {
	exponent, validExpectation := validExpectation(e)
	if len(raw) == 0 || len(raw) > 2<<20 || !validExpectation || e.PerPage != 100 {
		return Workspace{}, ErrUnavailable
	}
	root, ok := jsonvalue.Object(raw, "orders", "refunds", "products", "collected_from", "collected_through")
	if !ok || len(root) != 5 {
		return Workspace{}, ErrUnavailable
	}
	for _, shape := range []struct {
		name, rows        string
		fields, rowFields []string
	}{
		{"orders", "orders", []string{"grand_total_minor", "lifetime_refund_minor", "remainder_minor"}, []string{"id", "status", "created_at", "grand_total_minor", "lifetime_refund_minor", "remainder_minor"}},
		{"refunds", "refunds", []string{"amount_minor"}, []string{"id", "parent_id", "created_at", "amount_minor"}},
		{"products", "products", nil, []string{"product_id", "variation_id", "quantity", "order_count", "line_count", "total_minor", "tax_minor", "line_grand_minor"}},
	} {
		fields := append([]string{"client_id", "connection_id", "api_version", "currency", "currency_exponent", "start", "end", shape.rows}, shape.fields...)
		part, valid := jsonvalue.Object(root[shape.name], fields...)
		if !valid || len(part) != len(fields) {
			return Workspace{}, ErrUnavailable
		}
		var encodedExponent int
		if string(part["currency_exponent"]) == "null" || json.Unmarshal(part["currency_exponent"], &encodedExponent) != nil || encodedExponent != exponent {
			return Workspace{}, ErrUnavailable
		}
		rows, valid := array(part[shape.rows])
		if !valid {
			return Workspace{}, ErrUnavailable
		}
		for _, rawRow := range rows {
			row, valid := jsonvalue.Object(rawRow, shape.rowFields...)
			if !valid || len(row) != len(shape.rowFields) {
				return Workspace{}, ErrUnavailable
			}
		}
	}
	var result Workspace
	if json.Unmarshal(raw, &result) != nil || !ValidWorkspace(result, e) {
		return Workspace{}, ErrUnavailable
	}
	for _, stamp := range []struct {
		name string
		time time.Time
	}{{"collected_from", result.CollectedFrom}, {"collected_through", result.CollectedThrough}} {
		text, ok := text(root[stamp.name])
		if !ok || text != stamp.time.Format(time.RFC3339Nano) {
			return Workspace{}, ErrUnavailable
		}
	}
	return result, nil
}
