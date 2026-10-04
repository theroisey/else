// Package ga4 fetches and interprets bounded aggregate Data API v1beta reports.
// Persistence, application authorization and lifecycle fences belong to callers.
package ga4

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode"
	"unicode/utf8"
)

const APIVersion = "v1beta"
const maxPageBytes = 64 * 1024

var ErrUnavailable = errors.New("GA4 report unavailable")

// Column metadata must be freshly verified for the authorized property and
// exact request. These fields validate integrity, not freshness or ownership.
type Dimension struct {
	Name, Compatibility string
	CustomDefinition    bool
}

type Metric struct {
	Name, Type, Compatibility, Expression string
	CustomDefinition                      bool
	BlockedReasons                        []string
}

// Expectation describes one range, without comparisons/cohorts/aggregations or
// expressions. Callers approve aggregate dimensions for privacy before use.
// PropertyID is not echoed by RunReport; fixed-origin transport must bind it.
type Expectation struct {
	ClientID, ConnectionID, PropertyID, Timezone, Since, Until string
	Dimensions                                                 []Dimension
	Metrics                                                    []Metric
	Limit                                                      int
}

// Offset is the actual request offset, never an untrusted response cursor.
type Page struct {
	Offset int
	Body   []byte
}

type Row struct {
	Dimensions []string `json:"dimensions"`
	Metrics    []string `json:"metrics"`
}

type Report struct {
	ClientID     string   `json:"client_id"`
	ConnectionID string   `json:"connection_id"`
	APIVersion   string   `json:"api_version"`
	Timezone     string   `json:"timezone"`
	Since        string   `json:"since"`
	Until        string   `json:"until"`
	Dimensions   []string `json:"dimensions"`
	Metrics      []string `json:"metrics"`
	Rows         []Row    `json:"rows"`
}

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var property = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
var name = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
var integer = regexp.MustCompile(`^(0|[1-9][0-9]{0,17})$`)

// NormalizeIntegerReport fails atomically on unsupported quality, schema or
// incomplete pagination. Counts stay strings; nonadditive metrics are not summed.
func NormalizeIntegerReport(e Expectation, pages []Page) (Report, error) {
	return normalizeReport(e, pages, false)
}

// NormalizeMetricReport also supports freshly verified TYPE_FLOAT metrics and
// a dimensionless period total. Float values become bounded exact decimal
// strings; no binary floating arithmetic or rounding is used. Counts/users are
// not summed across dates/dimensions to manufacture period totals.
func NormalizeMetricReport(e Expectation, pages []Page) (Report, error) {
	return normalizeReport(e, pages, true)
}

func normalizeReport(e Expectation, pages []Page, extended bool) (Report, error) {
	if !validExpectationTypes(e, extended) || len(pages) == 0 || len(pages) > 5 {
		return Report{}, ErrUnavailable
	}
	r := Report{ClientID: e.ClientID, ConnectionID: e.ConnectionID, APIVersion: APIVersion,
		Timezone: e.Timezone, Since: e.Since, Until: e.Until, Rows: make([]Row, 0)}
	r.Dimensions = make([]string, 0, len(e.Dimensions))
	for _, d := range e.Dimensions {
		r.Dimensions = append(r.Dimensions, d.Name)
	}
	for _, m := range e.Metrics {
		r.Metrics = append(r.Metrics, m.Name)
	}
	seen := map[string]bool{}
	total := -1
	for index, page := range pages {
		if page.Offset != len(r.Rows) || len(page.Body) == 0 || len(page.Body) > maxPageBytes || !utf8.Valid(page.Body) {
			return Report{}, ErrUnavailable
		}
		p, ok := object(page.Body, "dimensionHeaders", "metricHeaders", "rows", "rowCount", "metadata", "kind", "totals", "maximums", "minimums")
		if !ok || !exactString(p["kind"], "analyticsData#runReport") ||
			!validHeaders(p["dimensionHeaders"], r.Dimensions, false) || !validMetricHeaders(p["metricHeaders"], e.Metrics) ||
			!validMetadata(p["metadata"], e.Timezone) {
			return Report{}, ErrUnavailable
		}
		for _, key := range []string{"totals", "maximums", "minimums"} {
			if !emptyArray(p[key]) {
				return Report{}, ErrUnavailable
			}
		}
		// Protobuf JSON can omit the zero default, but explicit null is unsupported.
		rowCount := 0
		if raw, exists := p["rowCount"]; exists {
			if !regexpInteger(raw) {
				return Report{}, ErrUnavailable
			}
			var err error
			rowCount, err = strconv.Atoi(string(raw))
			if err != nil || rowCount > 1000 {
				return Report{}, ErrUnavailable
			}
		}
		if total < 0 {
			total = rowCount
		}
		if rowCount != total || page.Offset > total || (index > 0 && page.Offset == total) {
			return Report{}, ErrUnavailable
		}
		rows, ok := array(p["rows"], true)
		expected := min(e.Limit, total-page.Offset)
		if !ok || len(rows) != expected || (index < len(pages)-1 && page.Offset+len(rows) >= total) {
			return Report{}, ErrUnavailable
		}
		for _, raw := range rows {
			row, ok := object(raw, "dimensionValues", "metricValues")
			if !ok || (len(row) != 2 && !(extended && len(e.Dimensions) == 0 && len(row) == 1)) {
				return Report{}, ErrUnavailable
			}
			dims, ok := values(row["dimensionValues"], len(e.Dimensions), false)
			if !ok {
				return Report{}, ErrUnavailable
			}
			metrics, ok := metricValues(row["metricValues"], e.Metrics)
			if !ok {
				return Report{}, ErrUnavailable
			}
			key, _ := json.Marshal(dims) // JSON framing avoids delimiter collisions.
			if seen[string(key)] {
				return Report{}, ErrUnavailable
			}
			seen[string(key)] = true
			r.Rows = append(r.Rows, Row{Dimensions: dims, Metrics: metrics})
		}
	}
	if len(r.Rows) != total {
		return Report{}, ErrUnavailable
	}
	return r, nil
}

func validExpectation(e Expectation) bool {
	return validExpectationTypes(e, false)
}
func validExpectationTypes(e Expectation, extended bool) bool {
	validID := func(id string) bool { return uuid.MatchString(id) && id != "00000000-0000-0000-0000-000000000000" }
	if !validID(e.ClientID) || !validID(e.ConnectionID) || !property.MatchString(e.PropertyID) ||
		e.Limit < 1 || e.Limit > 250 || (!extended && len(e.Dimensions) < 1) || len(e.Dimensions) > 3 || len(e.Metrics) < 1 || len(e.Metrics) > 6 ||
		e.Timezone == "" || e.Timezone == "Local" || len(e.Timezone) > 128 {
		return false
	}
	if _, err := time.LoadLocation(e.Timezone); err != nil {
		return false
	}
	since, err1 := time.Parse(time.DateOnly, e.Since)
	until, err2 := time.Parse(time.DateOnly, e.Until)
	if err1 != nil || err2 != nil || since.Year() < 2000 || since.Format(time.DateOnly) != e.Since ||
		until.Format(time.DateOnly) != e.Until || until.Before(since) || until.Sub(since) > 30*24*time.Hour {
		return false
	}
	seen := map[string]bool{}
	for _, d := range e.Dimensions {
		if !name.MatchString(d.Name) || seen[d.Name] || d.Compatibility != "COMPATIBLE" || d.CustomDefinition {
			return false
		}
		seen[d.Name] = true
	}
	for _, m := range e.Metrics {
		if !name.MatchString(m.Name) || seen[m.Name] || m.Compatibility != "COMPATIBLE" || (m.Type != "TYPE_INTEGER" && (!extended || m.Type != "TYPE_FLOAT")) ||
			m.CustomDefinition || m.Expression != "" || len(m.BlockedReasons) != 0 {
			return false
		}
		seen[m.Name] = true
	}
	return true
}

func validHeaders(raw []byte, names []string, metric bool) bool {
	headers, ok := array(raw, len(names) == 0)
	if !ok || len(headers) != len(names) {
		return false
	}
	for index, raw := range headers {
		h, ok := object(raw, "name", "type")
		if !ok || !exactString(h["name"], names[index]) || (metric && (len(h) != 2 || !exactString(h["type"], "TYPE_INTEGER"))) || (!metric && len(h) != 1) {
			return false
		}
	}
	return true
}

func values(raw []byte, width int, metric bool) ([]string, bool) {
	items, ok := array(raw, width == 0)
	if !ok || len(items) != width {
		return nil, false
	}
	result := make([]string, width)
	for index, raw := range items {
		v, ok := object(raw, "value")
		var s string
		if !ok || len(v) != 1 || !stringValue(v["value"], &s) {
			return nil, false
		}
		if metric {
			if !integer.MatchString(s) {
				return nil, false
			}
		} else {
			if len(s) > 1024 || strings.HasPrefix(s, "RESERVED_") {
				return nil, false
			}
			for _, char := range s {
				if unicode.IsControl(char) || char == utf8.RuneError {
					return nil, false
				}
			}
		}
		result[index] = s
	}
	return result, true
}
