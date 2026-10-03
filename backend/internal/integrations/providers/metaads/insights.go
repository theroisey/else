// Package metaads interprets the verified v26.0 daily account Insights contract.
// It does not authorize callers, access credentials, fetch pages or persist data.
package metaads

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"regexp"
	"sort"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode/utf8"
)

const GraphVersion = "v26.0"
const maxPageBytes = 64 * 1024

var ErrInvalid = errors.New("Meta daily Insights unavailable")

// Expectation must come from authorized immutable connection/account metadata.
// Dates are inclusive account-local calendar dates, not UTC instants.
type Expectation struct {
	ClientID, ConnectionID, AccountID, Currency, Timezone, Since, Until string
}

type Metrics struct {
	SpendDecimal string  `json:"spend_decimal"`
	Impressions  string  `json:"impressions"`
	Clicks       string  `json:"clicks"`
	CTRPercent   *string `json:"ctr_percent"`
	CPCDecimal   *string `json:"cpc_decimal"`
	CPMDecimal   *string `json:"cpm_decimal"`
}

type Day struct {
	Date string `json:"date"`
	Metrics
}

type Report struct {
	ClientID     string  `json:"client_id"`
	ConnectionID string  `json:"connection_id"`
	GraphVersion string  `json:"graph_version"`
	Currency     string  `json:"currency"`
	Timezone     string  `json:"timezone"`
	Since        string  `json:"since"`
	Until        string  `json:"until"`
	Days         []Day   `json:"days"`
	Totals       Metrics `json:"totals"`
	Attribution  string  `json:"attribution_status"`
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var accountPattern = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
var currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)
var countPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,17})$`)
var spendPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$`)

// Normalize accepts a complete ordered page sequence. It fails atomically rather
// than returning partial totals. Provider navigation URLs/cursors are discarded.
func Normalize(e Expectation, pages [][]byte) (Report, error) {
	if !validExpectation(e) || len(pages) == 0 || len(pages) > 4 {
		return Report{}, ErrInvalid
	}
	report := Report{ClientID: e.ClientID, ConnectionID: e.ConnectionID,
		GraphVersion: GraphVersion, Currency: e.Currency, Timezone: e.Timezone,
		Since: e.Since, Until: e.Until, Days: make([]Day, 0), Attribution: "unavailable"}
	seenDates, seenCursors := map[string]bool{}, map[string]bool{}
	spend, impressions, clicks := new(big.Rat), new(big.Int), new(big.Int)
	for index, body := range pages {
		if len(body) > maxPageBytes || !utf8.Valid(body) {
			return Report{}, ErrInvalid
		}
		page, ok := object(body, "data", "paging")
		if !ok || len(page["data"]) == 0 || page["data"][0] != '[' {
			return Report{}, ErrInvalid
		}
		var rows []json.RawMessage
		if json.Unmarshal(page["data"], &rows) != nil || len(rows) > 31 {
			return Report{}, ErrInvalid
		}
		next, cursor, ok := pagination(page["paging"])
		if !ok || next != (index < len(pages)-1) || (next && (len(rows) == 0 || cursor == "" || seenCursors[cursor])) {
			return Report{}, ErrInvalid
		}
		if next {
			seenCursors[cursor] = true
		}
		for _, raw := range rows {
			row, ok := object(raw, "account_id", "account_currency", "date_start", "date_stop", "spend", "impressions", "clicks")
			if !ok || len(row) != 7 {
				return Report{}, ErrInvalid
			}
			values := make(map[string]string, 7)
			for key, rawValue := range row {
				var value string
				if json.Unmarshal(rawValue, &value) != nil || value == "" {
					return Report{}, ErrInvalid
				}
				values[key] = value
			}
			date := values["date_start"]
			if values["account_id"] != e.AccountID || values["account_currency"] != e.Currency ||
				!validDate(date) || date != values["date_stop"] || date < e.Since || date > e.Until ||
				seenDates[date] || len(seenDates) >= 31 || !spendPattern.MatchString(values["spend"]) ||
				!countPattern.MatchString(values["impressions"]) || !countPattern.MatchString(values["clicks"]) {
				return Report{}, ErrInvalid
			}
			seenDates[date] = true
			daySpend, _ := new(big.Rat).SetString(values["spend"])
			dayImpressions, _ := new(big.Int).SetString(values["impressions"], 10)
			dayClicks, _ := new(big.Int).SetString(values["clicks"], 10)
			report.Days = append(report.Days, Day{Date: date, Metrics: metrics(daySpend, dayImpressions, dayClicks)})
			spend.Add(spend, daySpend)
			impressions.Add(impressions, dayImpressions)
			clicks.Add(clicks, dayClicks)
		}
	}
	sort.Slice(report.Days, func(i, j int) bool { return report.Days[i].Date < report.Days[j].Date })
	report.Totals = metrics(spend, impressions, clicks)
	return report, nil
}

func validExpectation(e Expectation) bool {
	validID := func(id string) bool {
		return uuidPattern.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
	}
	if !validID(e.ClientID) || !validID(e.ConnectionID) || !accountPattern.MatchString(e.AccountID) ||
		!currencyPattern.MatchString(e.Currency) || !validDate(e.Since) || !validDate(e.Until) ||
		e.Timezone == "Local" || e.Timezone == "" || len(e.Timezone) > 128 {
		return false
	}
	if _, err := time.LoadLocation(e.Timezone); err != nil {
		return false
	}
	since, _ := time.Parse(time.DateOnly, e.Since)
	until, _ := time.Parse(time.DateOnly, e.Until)
	return !until.Before(since) && until.Sub(since) <= 30*24*time.Hour
}

func validDate(s string) bool {
	d, err := time.Parse(time.DateOnly, s)
	return err == nil && d.Year() >= 2000 && d.Format(time.DateOnly) == s
}

// object rejects duplicate decoded names, case aliases, unknown keys and trailing
// JSON instead of encoding/json's default last-value-wins behavior.
func object(raw []byte, allowed ...string) (map[string]json.RawMessage, bool) {
	d := json.NewDecoder(bytes.NewReader(raw))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return nil, false
	}
	result := make(map[string]json.RawMessage)
	for d.More() {
		token, err = d.Token()
		key, ok := token.(string)
		if err != nil || !ok || result[key] != nil {
			return nil, false
		}
		known := false
		for _, candidate := range allowed {
			known = known || key == candidate
		}
		if !known {
			return nil, false
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, false
		}
		result[key] = value
	}
	if token, err = d.Token(); err != nil || token != json.Delim('}') {
		return nil, false
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, false
	}
	return result, true
}

func pagination(raw []byte) (next bool, cursor string, ok bool) {
	if raw == nil {
		return false, "", true
	}
	p, ok := object(raw, "cursors", "next", "previous")
	if !ok {
		return false, "", false
	}
	for _, key := range []string{"next", "previous"} {
		if value, exists := p[key]; exists {
			var s string
			if json.Unmarshal(value, &s) != nil || s == "" || len(s) > 8192 || strings.ContainsAny(s, "\r\n\x00") {
				return false, "", false
			}
			next = next || key == "next"
		}
	}
	if rawCursors, exists := p["cursors"]; exists {
		c, ok := object(rawCursors, "before", "after")
		if !ok {
			return false, "", false
		}
		for key, value := range c {
			var s string
			if json.Unmarshal(value, &s) != nil || s == "" || len(s) > 256 {
				return false, "", false
			}
			for _, char := range s {
				if char < 33 || char > 126 {
					return false, "", false
				}
			}
			if key == "after" {
				cursor = s
			}
		}
	}
	return next, cursor, true
}

func metrics(spend *big.Rat, impressions, clicks *big.Int) Metrics {
	decimal := strings.TrimRight(strings.TrimRight(spend.FloatString(6), "0"), ".")
	return Metrics{SpendDecimal: decimal, Impressions: impressions.String(), Clicks: clicks.String(),
		CTRPercent: ratio(new(big.Rat).SetInt(clicks), impressions, 100),
		CPCDecimal: ratio(spend, clicks, 1), CPMDecimal: ratio(spend, impressions, 1000)}
}

func ratio(numerator *big.Rat, denominator *big.Int, multiplier int64) *string {
	if denominator.Sign() == 0 {
		return nil
	}
	n := new(big.Int).Mul(numerator.Num(), big.NewInt(multiplier*1_000_000))
	d := new(big.Int).Mul(numerator.Denom(), denominator)
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(n, d, remainder)
	if new(big.Int).Lsh(remainder, 1).Cmp(d) >= 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	s := quotient.String()
	if len(s) <= 6 {
		s = strings.Repeat("0", 7-len(s)) + s
	}
	s = s[:len(s)-6] + "." + s[len(s)-6:]
	return &s
}
