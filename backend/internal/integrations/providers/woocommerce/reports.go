// Package woocommerce interprets minimal verified wc/v3 order/refund projections.
// It performs no authorization, credential access, network or persistence.
package woocommerce

import (
	"bytes"
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/theroisey/else/backend/internal/integrations/providers/internal/jsonvalue"
)

const APIVersion = "wc/v3"
const DecimalPlaces = 6 // Caller must request dp=6; the response does not echo it.
var ErrUnavailable = errors.New("WooCommerce report unavailable")
var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var id = regexp.MustCompile(`^[1-9][0-9]{0,17}$`)
var count = regexp.MustCompile(`^(0|[1-9][0-9]{0,2})$`)
var decimal = regexp.MustCompile(`^(0|[1-9][0-9]{0,17})\.[0-9]{6}$`)

// Expectation comes from authorized immutable connection/report metadata.
// The half-open period uses canonical UTC RFC3339 seconds, not shop-local dates.
type Expectation struct {
	ClientID, ConnectionID, Currency, Start, End string
	PerPage                                      int
}

// Page carries the trusted request number and single parsed X-WP-Total headers.
// A later transport must reject duplicate/ambiguous headers before constructing it.
type Page struct {
	Number            int
	Total, TotalPages string
	Body              []byte
}
type Order struct {
	ID                  string `json:"id"`
	Status              string `json:"status"`
	CreatedAt           string `json:"created_at"`
	GrandTotalMinor     string `json:"grand_total_minor"`
	LifetimeRefundMinor string `json:"lifetime_refund_minor"`
	RemainderMinor      string `json:"remainder_minor"`
}
type OrderReport struct {
	ClientID            string  `json:"client_id"`
	ConnectionID        string  `json:"connection_id"`
	APIVersion          string  `json:"api_version"`
	Currency            string  `json:"currency"`
	CurrencyExponent    int     `json:"currency_exponent"`
	Start               string  `json:"start"`
	End                 string  `json:"end"`
	Orders              []Order `json:"orders"`
	GrandTotalMinor     string  `json:"grand_total_minor"`
	LifetimeRefundMinor string  `json:"lifetime_refund_minor"`
	RemainderMinor      string  `json:"remainder_minor"`
}

// Parent binds an independently fetched order outside/inside the refund period.
// Refund responses do not contain currency. Never guess it from the shop default.
type Parent struct{ ID, Currency string }
type Refund struct {
	ID          string `json:"id"`
	ParentID    string `json:"parent_id"`
	CreatedAt   string `json:"created_at"`
	AmountMinor string `json:"amount_minor"`
}
type RefundReport struct {
	ClientID         string   `json:"client_id"`
	ConnectionID     string   `json:"connection_id"`
	APIVersion       string   `json:"api_version"`
	Currency         string   `json:"currency"`
	CurrencyExponent int      `json:"currency_exponent"`
	Start            string   `json:"start"`
	End              string   `json:"end"`
	Refunds          []Refund `json:"refunds"`
	AmountMinor      string   `json:"amount_minor"`
}

// NormalizeOrders reports an observed order-created cohort, including all statuses.
// Embedded lifetime refunds have no dates; this is not recognized or cash revenue.
func NormalizeOrders(e Expectation, pages []Page) (OrderReport, error) {
	exponent, ok := validExpectation(e)
	if !ok {
		return OrderReport{}, ErrUnavailable
	}
	rows, ok := completeRows(e, pages)
	if !ok {
		return OrderReport{}, ErrUnavailable
	}
	r := OrderReport{ClientID: e.ClientID, ConnectionID: e.ConnectionID, APIVersion: APIVersion, Currency: e.Currency, CurrencyExponent: exponent, Start: e.Start, End: e.End, Orders: make([]Order, 0, len(rows))}
	grand, refunds := new(big.Int), new(big.Int)
	previous := int64(0)
	seenRefunds := map[string]bool{}
	seenOrders := map[string]bool{}
	for _, raw := range rows {
		v, ok := jsonvalue.Object(raw, "id", "status", "currency", "date_created_gmt", "total", "refunds")
		if !ok || len(v) != 6 {
			return OrderReport{}, ErrUnavailable
		}
		orderID, number, ok := integerID(v["id"])
		if !ok || number <= previous || seenRefunds[orderID] {
			return OrderReport{}, ErrUnavailable
		}
		previous = number
		seenOrders[orderID] = true
		status, ok := text(v["status"])
		if !ok || !knownStatus(status) {
			return OrderReport{}, ErrUnavailable
		}
		currency, ok := text(v["currency"])
		if !ok || currency != e.Currency {
			return OrderReport{}, ErrUnavailable
		}
		created, ok := createdAt(v["date_created_gmt"], e)
		if !ok {
			return OrderReport{}, ErrUnavailable
		}
		totalText, ok := text(v["total"])
		if !ok {
			return OrderReport{}, ErrUnavailable
		}
		total, ok := minor(totalText, exponent)
		if !ok {
			return OrderReport{}, ErrUnavailable
		}
		summaries, ok := array(v["refunds"])
		if !ok || len(summaries) > 50 {
			return OrderReport{}, ErrUnavailable
		}
		refunded := new(big.Int)
		for _, raw := range summaries {
			s, ok := jsonvalue.Object(raw, "id", "total")
			if !ok || len(s) != 2 {
				return OrderReport{}, ErrUnavailable
			}
			refundID, _, ok := integerID(s["id"])
			if !ok || seenRefunds[refundID] || seenOrders[refundID] {
				return OrderReport{}, ErrUnavailable
			}
			seenRefunds[refundID] = true
			amount, ok := text(s["total"])
			if !ok || !strings.HasPrefix(amount, "-") {
				return OrderReport{}, ErrUnavailable
			}
			value, ok := minor(strings.TrimPrefix(amount, "-"), exponent)
			if !ok {
				return OrderReport{}, ErrUnavailable
			}
			refunded.Add(refunded, value)
		}
		if refunded.Cmp(total) > 0 {
			return OrderReport{}, ErrUnavailable
		}
		r.Orders = append(r.Orders, Order{orderID, status, created, total.String(), refunded.String(), new(big.Int).Sub(total, refunded).String()})
		grand.Add(grand, total)
		refunds.Add(refunds, refunded)
	}
	r.GrandTotalMinor = grand.String()
	r.LifetimeRefundMinor = refunds.String()
	r.RemainderMinor = new(big.Int).Sub(grand, refunds).String()
	return r, nil
}

// NormalizeRefunds reports refund-created events independently of order creation.
// Exact parent currency is mandatory, including orders outside this period.
func NormalizeRefunds(e Expectation, pages []Page, parents []Parent) (RefundReport, error) {
	exponent, ok := validExpectation(e)
	if !ok || len(parents) > 500 {
		return RefundReport{}, ErrUnavailable
	}
	rows, ok := completeRows(e, pages)
	if !ok {
		return RefundReport{}, ErrUnavailable
	}
	byID := map[string]bool{}
	for _, p := range parents {
		if !id.MatchString(p.ID) || p.Currency != e.Currency || byID[p.ID] {
			return RefundReport{}, ErrUnavailable
		}
		byID[p.ID] = true
	}
	used := map[string]bool{}
	r := RefundReport{ClientID: e.ClientID, ConnectionID: e.ConnectionID, APIVersion: APIVersion, Currency: e.Currency, CurrencyExponent: exponent, Start: e.Start, End: e.End, Refunds: make([]Refund, 0, len(rows))}
	total := new(big.Int)
	previous := int64(0)
	for _, raw := range rows {
		v, ok := jsonvalue.Object(raw, "id", "parent_id", "date_created_gmt", "amount")
		if !ok || len(v) != 4 {
			return RefundReport{}, ErrUnavailable
		}
		refundID, number, ok := integerID(v["id"])
		if !ok || number <= previous {
			return RefundReport{}, ErrUnavailable
		}
		previous = number
		parentID, _, ok := integerID(v["parent_id"])
		if !ok || !byID[parentID] || parentID == refundID {
			return RefundReport{}, ErrUnavailable
		}
		used[parentID] = true
		created, ok := createdAt(v["date_created_gmt"], e)
		if !ok {
			return RefundReport{}, ErrUnavailable
		}
		amount, ok := text(v["amount"])
		if !ok {
			return RefundReport{}, ErrUnavailable
		}
		value, ok := minor(amount, exponent)
		if !ok {
			return RefundReport{}, ErrUnavailable
		}
		r.Refunds = append(r.Refunds, Refund{refundID, parentID, created, value.String()})
		total.Add(total, value)
	}
	if len(used) != len(byID) {
		return RefundReport{}, ErrUnavailable
	}
	r.AmountMinor = total.String()
	return r, nil
}

func validExpectation(e Expectation) (int, bool) {
	for _, v := range []string{e.ClientID, e.ConnectionID} {
		if !uuid.MatchString(v) || v == "00000000-0000-0000-0000-000000000000" {
			return 0, false
		}
	}
	if e.PerPage < 1 || e.PerPage > 100 {
		return 0, false
	}
	start, err := time.Parse(time.RFC3339, e.Start)
	if err != nil || start.Year() < 2000 || start.Format(time.RFC3339) != e.Start || !strings.HasSuffix(e.Start, "Z") {
		return 0, false
	}
	end, err := time.Parse(time.RFC3339, e.End)
	if err != nil || end.Format(time.RFC3339) != e.End || !strings.HasSuffix(e.End, "Z") || !end.After(start) || end.Sub(start) > 31*24*time.Hour {
		return 0, false
	}
	switch e.Currency {
	case "USD", "EUR", "GBP", "TRY":
		return 2, true
	case "JPY":
		return 0, true
	case "KWD":
		return 3, true
	}
	return 0, false
}
func completeRows(e Expectation, pages []Page) ([]json.RawMessage, bool) {
	if len(pages) < 1 || len(pages) > 5 || !count.MatchString(pages[0].Total) || !count.MatchString(pages[0].TotalPages) {
		return nil, false
	}
	total, _ := strconv.Atoi(pages[0].Total)
	pageCount, _ := strconv.Atoi(pages[0].TotalPages)
	if total > 500 || pageCount != (total+e.PerPage-1)/e.PerPage || len(pages) != max(1, pageCount) {
		return nil, false
	}
	result := make([]json.RawMessage, 0, total)
	for i, p := range pages {
		if p.Number != i+1 || p.Total != pages[0].Total || p.TotalPages != pages[0].TotalPages || len(p.Body) > 64*1024 || !utf8.Valid(p.Body) {
			return nil, false
		}
		rows, ok := array(p.Body)
		if !ok || len(rows) != min(e.PerPage, total-len(result)) {
			return nil, false
		}
		result = append(result, rows...)
	}
	return result, len(result) == total
}
func array(raw []byte) ([]json.RawMessage, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '[' {
		return nil, false
	}
	var result []json.RawMessage
	if json.Unmarshal(raw, &result) != nil {
		return nil, false
	}
	return result, true
}
func text(raw []byte) (string, bool) {
	raw = bytes.TrimSpace(raw)
	var s string
	if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}
func integerID(raw []byte) (string, int64, bool) {
	s := string(bytes.TrimSpace(raw))
	if !id.MatchString(s) {
		return "", 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	return s, n, err == nil
}
func minor(s string, exponent int) (*big.Int, bool) {
	if !decimal.MatchString(s) {
		return nil, false
	}
	parts := strings.Split(s, ".")
	if strings.Trim(parts[1][exponent:], "0") != "" {
		return nil, false
	}
	value, ok := new(big.Int).SetString(parts[0]+parts[1][:exponent], 10)
	return value, ok && len(value.String()) <= 18
}
func createdAt(raw []byte, e Expectation) (string, bool) {
	s, ok := text(raw)
	if !ok {
		return "", false
	}
	t, err := time.Parse("2006-01-02T15:04:05", s)
	if err != nil || t.Format("2006-01-02T15:04:05") != s {
		return "", false
	}
	v := t.Format(time.RFC3339)
	return v, v >= e.Start && v < e.End
}
func knownStatus(s string) bool {
	switch s {
	case "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "trash":
		return true
	}
	return false
}
