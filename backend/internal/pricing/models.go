// Package pricing owns exact, append-only client agreements and billing copies.
package pricing

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var ErrInvalid = errors.New("invalid pricing input")
var ErrMissing = errors.New("pricing unavailable")
var ErrConflict = errors.New("pricing conflict")
var errReplay = errors.New("committed collection reconciliation")

type LineInput struct {
	Description    string  `json:"description"`
	Kind           string  `json:"kind"`
	Frequency      string  `json:"frequency"`
	QuantityMicros string  `json:"quantity_micros"`
	UnitPriceMinor string  `json:"unit_price_minor"`
	DiscountBPS    string  `json:"discount_bps"`
	TaxBPS         string  `json:"tax_bps"`
	UnitCostMinor  *string `json:"unit_cost_minor,omitempty"`
}
type Profile struct {
	Title          string      `json:"title"`
	Note           string      `json:"note"`
	Currency       string      `json:"currency"`
	EffectiveFrom  string      `json:"effective_from"`
	EffectiveUntil *string     `json:"effective_until"`
	Lines          []LineInput `json:"lines"`
}
type Totals struct {
	BaseMinor     string  `json:"base_minor"`
	DiscountMinor string  `json:"discount_minor"`
	NetMinor      string  `json:"net_minor"`
	TaxMinor      string  `json:"tax_minor"`
	TotalMinor    string  `json:"total_minor"`
	CostMinor     *string `json:"cost_minor,omitempty"`
}
type Line struct {
	LineInput
	Position int `json:"position"`
	Totals
}
type Calculation struct {
	Currency         string `json:"currency"`
	CurrencyExponent int    `json:"currency_exponent"`
	Lines            []Line `json:"lines"`
	Totals
}
type Version struct {
	ID             string    `json:"id"`
	SheetID        string    `json:"sheet_id"`
	ClientID       string    `json:"client_id"`
	Revision       string    `json:"revision"`
	Title          string    `json:"title"`
	Note           string    `json:"note"`
	EffectiveFrom  string    `json:"effective_from"`
	EffectiveUntil *string   `json:"effective_until"`
	WindowUntil    *string   `json:"window_until"`
	CreatedBy      string    `json:"created_by"`
	CreatedAt      time.Time `json:"created_at"`
	Calculation
}
type Sheet struct {
	ID            string  `json:"id"`
	ClientID      string  `json:"client_id"`
	Revision      string  `json:"revision"`
	LatestVersion Version `json:"latest_version"`
}
type Mutation struct {
	ID        string `json:"id"`
	VersionID string `json:"version_id"`
	Revision  string `json:"revision"`
}
type CopyInput struct {
	CommandID    string  `json:"command_id"`
	BillingDate  string  `json:"billing_date"`
	DueDate      *string `json:"due_date"`
	InternalNote string  `json:"internal_note"`
}
type CollectionMutation struct {
	ID       string `json:"id"`
	Revision string `json:"revision"`
	Replayed bool   `json:"replayed"`
}
type Snapshot struct {
	CollectionID    string    `json:"collection_id"`
	ClientID        string    `json:"client_id"`
	SheetID         string    `json:"sheet_id"`
	VersionID       string    `json:"version_id"`
	PricingRevision string    `json:"pricing_revision"`
	CommandID       string    `json:"command_id"`
	BillingDate     string    `json:"billing_date"`
	Title           string    `json:"title"`
	CreatedBy       string    `json:"created_by"`
	CreatedAt       time.Time `json:"created_at"`
	Calculation
}
type Pagination struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"next_cursor"`
}
type Page[T any] struct {
	Data []T        `json:"data"`
	Page Pagination `json:"page"`
}

var idPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var integerPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,18})$`)

func validID(v string) bool {
	return idPattern.MatchString(v) && v != "00000000-0000-0000-0000-000000000000"
}
func integer(v string, positive bool) (int64, error) {
	if !integerPattern.MatchString(v) {
		return 0, ErrInvalid
	}
	n, e := strconv.ParseInt(v, 10, 64)
	if e != nil || positive && n == 0 {
		return 0, ErrInvalid
	}
	return n, nil
}
func exponent(v string) (int, bool) {
	switch v {
	case "USD", "EUR", "GBP", "TRY":
		return 2, true
	case "JPY":
		return 0, true
	case "KWD":
		return 3, true
	}
	return 0, false
}
func validDate(v string) bool {
	t, e := time.Parse("2006-01-02", v)
	return e == nil && t.Year() >= 1 && t.Format("2006-01-02") == v
}
func text(v string, max int, multiline bool) bool {
	if !utf8.ValidString(v) || utf8.RuneCountInString(v) > max {
		return false
	}
	for _, c := range v {
		if unicode.IsControl(c) && (!multiline || c != '\n') {
			return false
		}
	}
	return true
}
func normalize(p Profile) (Profile, error) {
	p.Title = strings.TrimSpace(p.Title)
	p.Note = strings.TrimSpace(p.Note)
	if p.Title == "" || !text(p.Title, 200, false) || !text(p.Note, 2000, true) || !validDate(p.EffectiveFrom) || p.EffectiveUntil != nil && (!validDate(*p.EffectiveUntil) || *p.EffectiveUntil <= p.EffectiveFrom) {
		return p, ErrInvalid
	}
	// Copy before normalizing so callers retain their original command values.
	p.Lines = append([]LineInput(nil), p.Lines...)
	for i := range p.Lines {
		p.Lines[i].Description = strings.TrimSpace(p.Lines[i].Description)
	}
	_, e := Calculate(p)
	return p, e
}

// roundedProduct uses arbitrary-width intermediates and positive half-up rounding.
func roundedProduct(a, b, divisor int64) (*big.Int, error) {
	n := new(big.Int).Mul(big.NewInt(a), big.NewInt(b))
	n.Add(n, big.NewInt(divisor/2))
	n.Quo(n, big.NewInt(divisor))
	if !n.IsInt64() {
		return nil, ErrInvalid
	}
	return n, nil
}

// Calculate rounds each line's base, discount and tax separately, then sums.
func Calculate(p Profile) (Calculation, error) {
	exp, ok := exponent(p.Currency)
	r := Calculation{Currency: p.Currency, CurrencyExponent: exp, Lines: []Line{}}
	if !ok || len(p.Lines) < 1 || len(p.Lines) > 50 {
		return r, ErrInvalid
	}
	sums := [6]*big.Int{}
	for i := range sums {
		sums[i] = new(big.Int)
	}
	knownCost := true
	for i, v := range p.Lines {
		if v.Description == "" || !text(v.Description, 200, false) {
			return r, ErrInvalid
		}
		switch v.Frequency {
		case "none", "weekly", "monthly", "quarterly", "yearly":
		default:
			return r, ErrInvalid
		}
		switch v.Kind {
		case "recurring":
			if v.Frequency == "none" {
				return r, ErrInvalid
			}
		case "one_time":
			if v.Frequency != "none" {
				return r, ErrInvalid
			}
		case "custom":
		default:
			return r, ErrInvalid
		}
		q, e := integer(v.QuantityMicros, true)
		if e != nil {
			return r, e
		}
		u, e := integer(v.UnitPriceMinor, false)
		if e != nil {
			return r, e
		}
		d, e := integer(v.DiscountBPS, false)
		if e != nil || d > 10000 {
			return r, ErrInvalid
		}
		t, e := integer(v.TaxBPS, false)
		if e != nil || t > 10000 {
			return r, ErrInvalid
		}
		base, e := roundedProduct(q, u, 1000000)
		if e != nil {
			return r, e
		}
		discount, e := roundedProduct(base.Int64(), d, 10000)
		if e != nil {
			return r, e
		}
		net := new(big.Int).Sub(base, discount)
		tax, e := roundedProduct(net.Int64(), t, 10000)
		if e != nil {
			return r, e
		}
		total := new(big.Int).Add(net, tax)
		values := []*big.Int{base, discount, net, tax, total}
		cost := (*string)(nil)
		if v.UnitCostMinor != nil {
			c, e := integer(*v.UnitCostMinor, false)
			if e != nil {
				return r, e
			}
			value, e := roundedProduct(q, c, 1000000)
			if e != nil {
				return r, e
			}
			s := value.String()
			cost = &s
			sums[5].Add(sums[5], value)
		} else {
			knownCost = false
		}
		for j, value := range values {
			if !value.IsInt64() {
				return r, ErrInvalid
			}
			sums[j].Add(sums[j], value)
		}
		r.Lines = append(r.Lines, Line{LineInput: v, Position: i + 1, Totals: Totals{base.String(), discount.String(), net.String(), tax.String(), total.String(), cost}})
	}
	for _, sum := range sums {
		if !sum.IsInt64() {
			return r, ErrInvalid
		}
	}
	r.Totals = Totals{BaseMinor: sums[0].String(), DiscountMinor: sums[1].String(), NetMinor: sums[2].String(), TaxMinor: sums[3].String(), TotalMinor: sums[4].String()}
	if knownCost {
		v := sums[5].String()
		r.CostMinor = &v
	}
	return r, nil
}
func normalizeCopy(p CopyInput) (CopyInput, error) {
	p.CommandID = strings.ToLower(p.CommandID)
	p.InternalNote = strings.TrimSpace(p.InternalNote)
	if !validID(p.CommandID) || !validDate(p.BillingDate) || p.DueDate != nil && !validDate(*p.DueDate) || !text(p.InternalNote, 8000, true) {
		return p, ErrInvalid
	}
	return p, nil
}
func newID() (string, error) {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		return "", e
	}
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
