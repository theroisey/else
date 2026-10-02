// Package billing owns exact collections and append-only payment commands.
package billing

import (
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var ErrInvalid = errors.New("invalid billing input")
var ErrMissing = errors.New("billing record unavailable")
var ErrConflict = errors.New("billing conflict")
var errReplay = errors.New("committed payment reconciliation")

type Profile struct {
	Description  string  `json:"description"`
	InternalNote string  `json:"internal_note"`
	AmountMinor  string  `json:"amount_minor"`
	Currency     string  `json:"currency"`
	DueDate      *string `json:"due_date"`
}
type PaymentInput struct {
	CommandID   string `json:"command_id"`
	AmountMinor string `json:"amount_minor"`
	Currency    string `json:"currency"`
	PaidOn      string `json:"paid_on"`
	Method      string `json:"method"`
	Reference   string `json:"reference"`
	Note        string `json:"note"`
}
type Collection struct {
	ID        string `json:"id"`
	ClientID  string `json:"client_id"`
	CreatedBy string `json:"created_by"`
	Profile
	CurrencyExponent int        `json:"currency_exponent"`
	PaidMinor        string     `json:"paid_minor"`
	OutstandingMinor string     `json:"outstanding_minor"`
	Status           string     `json:"status"`
	Revision         string     `json:"revision"`
	CancelledAt      *time.Time `json:"cancelled_at"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}
type Payment struct {
	ID           string `json:"id"`
	CollectionID string `json:"collection_id"`
	ClientID     string `json:"client_id"`
	RecordedBy   string `json:"recorded_by"`
	PaymentInput
	CollectionRevision string    `json:"collection_revision"`
	RecordedAt         time.Time `json:"recorded_at"`
}
type Mutation struct {
	ID        string  `json:"id"`
	Revision  string  `json:"revision"`
	PaymentID *string `json:"payment_id"`
	Replayed  bool    `json:"replayed"`
}
type Currency struct {
	Code     string `json:"code"`
	Exponent int    `json:"exponent"`
}
type Totals struct {
	Currency             string `json:"currency"`
	CurrencyExponent     int    `json:"currency_exponent"`
	AmountMinor          string `json:"amount_minor"`
	PaidMinor            string `json:"paid_minor"`
	OutstandingMinor     string `json:"outstanding_minor"`
	OverdueMinor         string `json:"overdue_minor"`
	CancelledAmountMinor string `json:"cancelled_amount_minor"`
	CancelledPaidMinor   string `json:"cancelled_paid_minor"`
}
type Pagination struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"next_cursor"`
}
type Page[T any] struct {
	Data []T        `json:"data"`
	Page Pagination `json:"page"`
}
type Filter struct {
	Limit                            int
	Cursor, Status, Currency, Search string
}

var idPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var integerPattern = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

func validID(v string) bool {
	return idPattern.MatchString(v) && v != "00000000-0000-0000-0000-000000000000"
}
func integer(v string) (int64, error) {
	if !integerPattern.MatchString(v) {
		return 0, ErrInvalid
	}
	n, e := strconv.ParseInt(v, 10, 64)
	if e != nil {
		return 0, ErrInvalid
	}
	return n, nil
}
func validCurrency(v string) bool {
	switch v {
	case "USD", "EUR", "GBP", "TRY", "JPY", "KWD":
		return true
	}
	return false
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
	p.Description = strings.TrimSpace(p.Description)
	p.InternalNote = strings.TrimSpace(p.InternalNote)
	if _, e := integer(p.AmountMinor); e != nil || !validCurrency(p.Currency) || p.Description == "" || !text(p.Description, 2000, true) || !text(p.InternalNote, 8000, true) || p.DueDate != nil && !validDate(*p.DueDate) {
		return p, ErrInvalid
	}
	return p, nil
}
func normalizePayment(p PaymentInput) (PaymentInput, error) {
	p.CommandID = strings.ToLower(p.CommandID)
	p.Reference = strings.TrimSpace(p.Reference)
	p.Note = strings.TrimSpace(p.Note)
	if _, e := integer(p.AmountMinor); e != nil || !validID(p.CommandID) || !validCurrency(p.Currency) || !validDate(p.PaidOn) || !text(p.Reference, 200, false) || !text(p.Note, 2000, true) {
		return p, ErrInvalid
	}
	switch p.Method {
	case "bank_transfer", "cash", "card", "other":
		return p, nil
	}
	return p, ErrInvalid
}
func validFilter(f Filter) bool {
	if f.Limit < 1 || f.Limit > 100 || f.Cursor != "" && !validID(f.Cursor) || f.Currency != "" && !validCurrency(f.Currency) || !text(f.Search, 100, false) {
		return false
	}
	switch f.Status {
	case "all", "pending", "partially_paid", "paid", "overdue", "cancelled":
		return true
	}
	return false
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
