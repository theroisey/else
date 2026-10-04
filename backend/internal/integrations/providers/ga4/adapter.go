package ga4

import (
	"context"
	"encoding/json"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/theroisey/else/backend/internal/integrations/providerhttp"
)

const adminOrigin = "https://analyticsadmin.googleapis.com"
const dataOrigin = "https://analyticsdata.googleapis.com"
const workspaceBudget = 120 * time.Second
const reportLimit = 200

// Adapter contains only fixed Google origins. Its transports and clock cannot
// be supplied by application callers; tests use package-private fixtures.
// Application authorization and generation fences must surround Fetch.
type Adapter struct {
	token, admin, metadata, data tokenTransport
	now                          func() time.Time
}

func NewAdapter(gate *providerhttp.Admission) (*Adapter, error) {
	token, e1 := providerhttp.New(tokenOrigin, gate)
	admin, e2 := providerhttp.New(adminOrigin, gate)
	data, e3 := providerhttp.New(dataOrigin, gate)
	metadata, e4 := providerhttp.NewWithResponseLimit(dataOrigin, gate, providerhttp.MaxMetadataResponseBytes)
	if e1 != nil || e2 != nil || e3 != nil || e4 != nil {
		return nil, ErrUnavailable
	}
	return &Adapter{token, admin, metadata, data, func() time.Time { return time.Now().UTC() }}, nil
}

// Request is private authorized backend context, never accepted as arbitrary
// report dimensions, filters, URLs, expressions or metric definitions.
type Request struct {
	ClientID, ConnectionID, PropertyID, Since, Until string
}

// Definition contains only selected current provider metric documentation.
// Render text as text; never interpret provider strings as markup or commands.
type Definition struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
}

type Workspace struct {
	Definitions []Definition `json:"definitions"`
	Summary     Report       `json:"summary"`
	Daily       Report       `json:"daily"`
	Acquisition Report       `json:"acquisition"`
	Devices     Report       `json:"devices"`
	Landing     Report       `json:"landing"`
}

func metricNames() []string {
	return []string{"activeUsers", "sessions", "screenPageViews", "keyEvents"}
}

// Fetch is one atomic, bounded background collection. It has no retry, refresh
// loop, cache, persistence, state transition or public route. Access to a property
// proves API read access, not legal ownership. All tables must validate before
// any workspace is returned; zero rows remain empty observations.
func (a *Adapter) Fetch(ctx context.Context, credential *ServiceAccount, request Request) (Workspace, error) {
	if a == nil || a.token == nil || a.admin == nil || a.metadata == nil || a.data == nil || a.now == nil || ctx == nil || ctx.Err() != nil || credential == nil || !validRequest(request) {
		return Workspace{}, ErrUnavailable
	}
	bounded, cancel := context.WithTimeout(ctx, workspaceBudget)
	defer cancel()
	token, err := credential.exchange(bounded, a.token, a.now())
	if err != nil {
		return Workspace{}, ErrUnavailable
	}
	timezone, err := a.propertyTimezone(bounded, token, request.PropertyID)
	if err != nil {
		return Workspace{}, ErrUnavailable
	}
	result := Workspace{}
	for _, template := range []struct {
		dimensions []string
		target     *Report
	}{
		{nil, &result.Summary},
		{[]string{"date"}, &result.Daily},
		{[]string{"date", "sessionDefaultChannelGroup"}, &result.Acquisition},
		{[]string{"date", "deviceCategory"}, &result.Devices},
		{[]string{"landingPage"}, &result.Landing},
	} {
		expectation := Expectation{ClientID: request.ClientID, ConnectionID: request.ConnectionID, PropertyID: request.PropertyID, Timezone: timezone, Since: request.Since, Until: request.Until, Limit: reportLimit}
		dimensions, metrics, definitions, err := a.compatibility(bounded, token, request.PropertyID, template.dimensions)
		if err != nil || (result.Definitions != nil && !reflect.DeepEqual(result.Definitions, definitions)) {
			return Workspace{}, ErrUnavailable
		}
		expectation.Dimensions, expectation.Metrics = dimensions, metrics
		report, err := a.report(bounded, token, expectation)
		if err != nil || !validTemplateRows(report) {
			return Workspace{}, ErrUnavailable
		}
		result.Definitions, *template.target = definitions, report
	}
	// Revalidate access and reporting timezone after the complete batch. The APIs
	// provide no cross-request snapshot; never claim transactionally frozen data.
	confirmed, err := a.propertyTimezone(bounded, token, request.PropertyID)
	if err != nil || timezone != confirmed || bounded.Err() != nil {
		return Workspace{}, ErrUnavailable
	}
	return result, nil
}

type fencedTransport struct {
	transport tokenTransport
	fence     func(context.Context) error
}

func (f fencedTransport) Do(ctx context.Context, method, path string, query url.Values, body []byte, authorization, contentType string) ([]byte, error) {
	if ctx == nil || ctx.Err() != nil || f.fence(ctx) != nil || ctx.Err() != nil {
		return nil, ErrUnavailable
	}
	return f.transport.Do(ctx, method, path, query, body, authorization, contentType)
}

// FetchFenced rechecks the caller's durable lease, current client permissions
// and connection/credential checkpoint before each provider request. No DB lock
// spans network work; revocation cannot retract an already issued request. A
// fresh transactional fence is still mandatory before publishing any results.
func (a *Adapter) FetchFenced(ctx context.Context, credential *ServiceAccount, request Request, fence func(context.Context) error) (Workspace, error) {
	if a == nil || a.token == nil || a.admin == nil || a.metadata == nil || a.data == nil || a.now == nil || fence == nil {
		return Workspace{}, ErrUnavailable
	}
	copy := *a
	copy.token = fencedTransport{a.token, fence}
	copy.admin = fencedTransport{a.admin, fence}
	copy.metadata = fencedTransport{a.metadata, fence}
	copy.data = fencedTransport{a.data, fence}
	return copy.Fetch(ctx, credential, request)
}

func validRequest(r Request) bool {
	e := Expectation{ClientID: r.ClientID, ConnectionID: r.ConnectionID, PropertyID: r.PropertyID, Since: r.Since, Until: r.Until, Timezone: "UTC", Limit: reportLimit, Metrics: []Metric{{Name: "activeUsers", Type: "TYPE_INTEGER", Compatibility: "COMPATIBLE"}}}
	return validExpectationTypes(e, true)
}

func (a *Adapter) propertyTimezone(ctx context.Context, token AccessToken, id string) (string, error) {
	header, err := token.Authorization(a.now())
	if err != nil || ctx.Err() != nil {
		return "", ErrUnavailable
	}
	raw, err := a.admin.Do(ctx, "GET", "/v1beta/properties/"+id, url.Values{"fields": {"name,timeZone,deleteTime"}}, nil, header, "")
	defer clear(raw)
	if err != nil || ctx.Err() != nil || len(raw) == 0 || len(raw) > maxPageBytes {
		return "", ErrUnavailable
	}
	fields, ok := object(raw, "name", "timeZone", "deleteTime")
	var timezone string
	if !ok || !exactString(fields["name"], "properties/"+id) || !stringValue(fields["timeZone"], &timezone) || timezone == "" || timezone == "Local" || len(timezone) > 128 {
		return "", ErrUnavailable
	}
	if _, present := fields["deleteTime"]; present {
		return "", ErrUnavailable
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		return "", ErrUnavailable
	}
	return timezone, nil
}

func namedColumns(names []string) []map[string]string {
	columns := make([]map[string]string, 0, len(names))
	for _, name := range names {
		columns = append(columns, map[string]string{"name": name})
	}
	return columns
}

func (a *Adapter) compatibility(ctx context.Context, token AccessToken, id string, dimensions []string) ([]Dimension, []Metric, []Definition, error) {
	header, err := token.Authorization(a.now())
	if err != nil || ctx.Err() != nil {
		return nil, nil, nil, ErrUnavailable
	}
	body, _ := json.Marshal(map[string]any{"dimensions": namedColumns(dimensions), "metrics": namedColumns(metricNames()), "compatibilityFilter": "COMPATIBLE"})
	projection := "dimensionCompatibilities(compatibility,dimensionMetadata(apiName,customDefinition)),metricCompatibilities(compatibility,metricMetadata(apiName,type,blockedReasons,customDefinition,expression,uiName,description))"
	raw, err := a.metadata.Do(ctx, "POST", "/v1beta/properties/"+id+":checkCompatibility", url.Values{"fields": {projection}}, body, header, "application/json")
	defer clear(raw)
	if err != nil || ctx.Err() != nil {
		return nil, nil, nil, ErrUnavailable
	}
	return parseCompatibility(raw, dimensions)
}

func (a *Adapter) report(ctx context.Context, token AccessToken, expectation Expectation) (Report, error) {
	if !validExpectationTypes(expectation, true) {
		return Report{}, ErrUnavailable
	}
	dimensions := make([]string, 0, len(expectation.Dimensions))
	orders := make([]map[string]any, 0, len(expectation.Dimensions))
	for _, dimension := range expectation.Dimensions {
		dimensions = append(dimensions, dimension.Name)
		orders = append(orders, map[string]any{"dimension": map[string]string{"dimensionName": dimension.Name, "orderType": "ALPHANUMERIC"}, "desc": false})
	}
	pages := make([]Page, 0, 5)
	defer func() {
		for _, page := range pages {
			clear(page.Body)
		}
	}()
	total := -1
	for offset := 0; len(pages) < 5; offset += reportLimit {
		header, err := token.Authorization(a.now())
		if err != nil || ctx.Err() != nil {
			return Report{}, ErrUnavailable
		}
		body, _ := json.Marshal(map[string]any{"dimensions": namedColumns(dimensions), "metrics": namedColumns(metricNames()), "dateRanges": []map[string]string{{"startDate": expectation.Since, "endDate": expectation.Until}}, "offset": strconv.Itoa(offset), "limit": strconv.Itoa(reportLimit), "orderBys": orders, "keepEmptyRows": false, "returnPropertyQuota": false})
		raw, err := a.data.Do(ctx, "POST", "/v1beta/properties/"+expectation.PropertyID+":runReport", nil, body, header, "application/json")
		if err != nil || ctx.Err() != nil || len(raw) == 0 || len(raw) > maxPageBytes {
			clear(raw)
			return Report{}, ErrUnavailable
		}
		pages = append(pages, Page{Offset: offset, Body: raw})
		count, ok := boundedRowCount(raw)
		if !ok || (total >= 0 && total != count) || (len(dimensions) == 0 && count > 1) {
			return Report{}, ErrUnavailable
		}
		total = count
		if offset+reportLimit >= total {
			break
		}
	}
	if ctx.Err() != nil {
		return Report{}, ErrUnavailable
	}
	return NormalizeMetricReport(expectation, pages)
}

func boundedRowCount(raw []byte) (int, bool) {
	fields, ok := object(raw, "dimensionHeaders", "metricHeaders", "rows", "rowCount", "metadata", "kind", "totals", "maximums", "minimums")
	if !ok {
		return 0, false
	}
	count := 0
	if value, present := fields["rowCount"]; present {
		if !regexpInteger(value) {
			return 0, false
		}
		parsed, err := strconv.Atoi(string(value))
		if err != nil || parsed > 1000 {
			return 0, false
		}
		count = parsed
	}
	return count, true
}

func validTemplateRows(report Report) bool {
	var previous []string
	for _, row := range report.Rows {
		if previous != nil && !tupleBefore(previous, row.Dimensions) {
			return false
		}
		previous = row.Dimensions
		for i, dimension := range report.Dimensions {
			value := row.Dimensions[i]
			switch dimension {
			case "date":
				date, err := time.Parse("20060102", value)
				if err != nil || date.Format("20060102") != value || date.Format(time.DateOnly) < report.Since || date.Format(time.DateOnly) > report.Until {
					return false
				}
			case "landingPage":
				if value != "(not set)" && (!strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.ContainsAny(value, "?#@\\")) {
					return false
				}
			case "deviceCategory", "sessionDefaultChannelGroup":
				if value == "" || len(value) > 256 {
					return false
				}
			default:
				return false
			}
		}
	}
	return true
}

func tupleBefore(left, right []string) bool {
	for i := range left {
		if left[i] != right[i] {
			return left[i] < right[i]
		}
	}
	return false
}

func metadataText(raw []byte, maximum int, multiline bool) (string, bool) {
	var text string
	if !stringValue(raw, &text) || len(text) == 0 || len(text) > maximum || !utf8.ValidString(text) {
		return "", false
	}
	for _, char := range text {
		if char == utf8.RuneError || (unicode.IsControl(char) && !(multiline && (char == '\n' || char == '\t'))) {
			return "", false
		}
	}
	return text, true
}
