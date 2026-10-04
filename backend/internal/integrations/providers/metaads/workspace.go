package metaads

import (
	"encoding/json"
	"reflect"
	"time"
	"unicode/utf8"
)

// ValidWorkspace reuses the reviewed exact interpreter to verify every derived
// metric and weighted total. Account ID remains private and is not part of DTOs.
func ValidWorkspace(w Workspace, r Request) bool {
	if !ValidRequest(r) || w.Report.ClientID != r.ClientID || w.Report.ConnectionID != r.ConnectionID ||
		w.Report.Since != r.Since || w.Report.Until != r.Until || w.Report.Days == nil || len(w.Report.Days) > 31 ||
		!validCollected(w.CollectedFrom) || !validCollected(w.CollectedThrough) || w.CollectedThrough.Before(w.CollectedFrom) ||
		w.CollectedThrough.Sub(w.CollectedFrom) > 121*time.Second {
		return false
	}
	e := Expectation{ClientID: r.ClientID, ConnectionID: r.ConnectionID, AccountID: r.AccountID,
		Currency: w.Report.Currency, Timezone: w.Report.Timezone, Since: r.Since, Until: r.Until}
	rows := make([]map[string]string, 0, len(w.Report.Days))
	previous := ""
	for _, row := range w.Report.Days {
		if row.Date <= previous {
			return false
		}
		previous = row.Date
		rows = append(rows, map[string]string{"account_id": r.AccountID, "account_currency": w.Report.Currency,
			"date_start": row.Date, "date_stop": row.Date, "spend": row.SpendDecimal, "impressions": row.Impressions, "clicks": row.Clicks})
	}
	body, err := json.Marshal(struct {
		Data []map[string]string `json:"data"`
	}{rows})
	if err != nil {
		return false
	}
	expected, err := Normalize(e, [][]byte{body})
	return err == nil && reflect.DeepEqual(expected, w.Report)
}

func validCollected(t time.Time) bool {
	_, offset := t.Zone()
	return t.Year() >= 2000 && t.Year() <= 9999 && offset == 0 && t.Nanosecond()%1000 == 0
}

// DecodeWorkspace rejects private/expanded/missing/duplicate raw fields at each
// layer before typed decoding. SQL jsonb has already canonicalized names.
func DecodeWorkspace(raw []byte, r Request) (Workspace, error) {
	if len(raw) == 0 || len(raw) > 2*1024*1024 || !utf8.Valid(raw) {
		return Workspace{}, ErrInvalid
	}
	root, ok := object(raw, "report", "collected_from", "collected_through")
	if !ok || len(root) != 3 {
		return Workspace{}, ErrInvalid
	}
	for _, key := range []string{"collected_from", "collected_through"} {
		var value string
		if json.Unmarshal(root[key], &value) != nil {
			return Workspace{}, ErrInvalid
		}
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err != nil || !validCollected(parsed) || parsed.UTC().Format(time.RFC3339Nano) != value {
			return Workspace{}, ErrInvalid
		}
	}
	report, ok := object(root["report"], "client_id", "connection_id", "graph_version", "currency", "timezone", "since", "until", "days", "totals", "attribution_status")
	if !ok || len(report) != 10 || len(report["days"]) == 0 || report["days"][0] != '[' {
		return Workspace{}, ErrInvalid
	}
	metricKeys := []string{"spend_decimal", "impressions", "clicks", "ctr_percent", "cpc_decimal", "cpm_decimal"}
	totals, ok := object(report["totals"], metricKeys...)
	if !ok || len(totals) != 6 {
		return Workspace{}, ErrInvalid
	}
	var days []json.RawMessage
	if json.Unmarshal(report["days"], &days) != nil || len(days) > 31 {
		return Workspace{}, ErrInvalid
	}
	for _, raw := range days {
		fields, ok := object(raw, append(metricKeys, "date")...)
		if !ok || len(fields) != 7 {
			return Workspace{}, ErrInvalid
		}
	}
	var w Workspace
	if json.Unmarshal(raw, &w) != nil || !ValidWorkspace(w, r) {
		return Workspace{}, ErrInvalid
	}
	return w, nil
}
