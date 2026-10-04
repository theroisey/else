package ga4

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/integrations/providerhttp"
)

type adapterTransport func(context.Context, string, string, url.Values, []byte, string, string) ([]byte, error)

func (f adapterTransport) Do(ctx context.Context, method, path string, query url.Values, body []byte, auth, content string) ([]byte, error) {
	return f(ctx, method, path, query, body, auth, content)
}

func compatibilityFixture() []byte {
	dimensions := make([]any, 0)
	for _, name := range []string{"landingPage", "deviceCategory", "sessionDefaultChannelGroup", "date", "unusedDimension"} {
		dimensions = append(dimensions, map[string]any{"compatibility": "COMPATIBLE", "dimensionMetadata": map[string]any{"apiName": name}})
	}
	metrics := make([]any, 0)
	for _, name := range []string{"unusedMetric", "keyEvents", "screenPageViews", "sessions", "activeUsers"} {
		kind := "TYPE_INTEGER"
		if name == "keyEvents" {
			kind = "TYPE_FLOAT"
		}
		metrics = append(metrics, map[string]any{"compatibility": "COMPATIBLE", "metricMetadata": map[string]any{"apiName": name, "type": kind, "uiName": "Synthetic " + name, "description": "Synthetic contract description for " + name}})
	}
	raw, _ := json.Marshal(map[string]any{"dimensionCompatibilities": dimensions, "metricCompatibilities": metrics})
	return raw
}

func requestedNames(t *testing.T, raw any) []string {
	t.Helper()
	array, ok := raw.([]any)
	if !ok {
		t.Fatal("requested column list unavailable")
	}
	names := make([]string, 0, len(array))
	for _, value := range array {
		column, ok := value.(map[string]any)
		if !ok || len(column) != 1 {
			t.Fatal("unsupported requested column")
		}
		name, ok := column["name"].(string)
		if !ok {
			t.Fatal("requested name unavailable")
		}
		names = append(names, name)
	}
	return names
}

func observedFixture(dimensions []string, offset, count int) []byte {
	dimensionHeaders := make([]any, 0)
	for _, name := range dimensions {
		dimensionHeaders = append(dimensionHeaders, map[string]string{"name": name})
	}
	metricHeaders := make([]any, 0)
	for _, name := range metricNames() {
		kind := "TYPE_INTEGER"
		if name == "keyEvents" {
			kind = "TYPE_FLOAT"
		}
		metricHeaders = append(metricHeaders, map[string]string{"name": name, "type": kind})
	}
	rows := make([]any, 0)
	for index := offset; index < min(offset+reportLimit, count); index++ {
		values := make([]any, 0)
		for _, name := range dimensions {
			value := ""
			switch name {
			case "date":
				value = "20261001"
			case "sessionDefaultChannelGroup":
				value = "Organic Search"
			case "deviceCategory":
				value = "desktop"
			case "landingPage":
				value = fmt.Sprintf("/synthetic/%04d", index)
			}
			values = append(values, map[string]string{"value": value})
		}
		row := map[string]any{"metricValues": []any{map[string]string{"value": "9007199254740993"}, map[string]string{"value": "27"}, map[string]string{"value": "81"}, map[string]string{"value": "1.3333333333333333"}}}
		if len(dimensions) > 0 {
			row["dimensionValues"] = values
		}
		rows = append(rows, row)
	}
	raw, _ := json.Marshal(map[string]any{"kind": "analyticsData#runReport", "dimensionHeaders": dimensionHeaders, "metricHeaders": metricHeaders, "rows": rows, "rowCount": count, "metadata": map[string]string{"timeZone": "Europe/Istanbul"}})
	return raw
}

type adapterFixture struct {
	adapter       *Adapter
	credential    *ServiceAccount
	request       Request
	calls         int
	metadataCalls int
	reportCalls   int
	adminCalls    int
	landingRows   int
	mutate        func(int, string, []byte) ([]byte, error)
}

func newAdapterFixture(t *testing.T) *adapterFixture {
	t.Helper()
	_, _, raw := serviceAccountFixture(t)
	credential, err := ParseServiceAccount(raw)
	clear(raw)
	if err != nil {
		t.Fatal(err)
	}
	f := &adapterFixture{credential: credential, request: Request{ClientID: "00000000-0000-4000-8000-000000000001", ConnectionID: "00000000-0000-4000-8000-000000000002", PropertyID: "1234", Since: "2026-10-01", Until: "2026-10-03"}, landingRows: 1}
	now := time.Date(2026, 10, 4, 10, 0, 0, 0, time.UTC)
	transport := adapterTransport(func(ctx context.Context, method, path string, query url.Values, body []byte, auth, content string) ([]byte, error) {
		f.calls++
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > workspaceBudget || time.Until(deadline) <= 0 {
			t.Fatal("workspace deadline missing or widened")
		}
		if path != "/token" && auth != "Bearer synthetic.private-token" {
			t.Fatal("private authorization was not bound to provider header")
		}
		if strings.Contains(path+query.Encode()+string(body), "synthetic.private-token") {
			t.Fatal("token exposed through a URL or report body")
		}
		var response []byte
		switch {
		case path == "/token":
			response = []byte(`{"access_token":"synthetic.private-token","token_type":"Bearer","expires_in":3600}`)
		case path == "/v1beta/properties/1234":
			f.adminCalls++
			if method != "GET" || query.Get("fields") != "name,timeZone,deleteTime" || len(query) != 1 || len(body) != 0 || content != "" {
				t.Fatal("property read contract changed")
			}
			response = []byte(`{"name":"properties/1234","timeZone":"Europe/Istanbul"}`)
		case path == "/v1beta/properties/1234:checkCompatibility":
			f.metadataCalls++
			var payload map[string]any
			if method != "POST" || content != "application/json" || json.Unmarshal(body, &payload) != nil || len(payload) != 3 || payload["compatibilityFilter"] != "COMPATIBLE" || !reflect.DeepEqual(requestedNames(t, payload["metrics"]), metricNames()) || len(query) != 1 || !strings.Contains(query.Get("fields"), "blockedReasons") || !strings.Contains(query.Get("fields"), "description") {
				t.Fatal("fresh compatibility projection changed")
			}
			response = compatibilityFixture()
		case path == "/v1beta/properties/1234:runReport":
			f.reportCalls++
			var payload map[string]any
			if method != "POST" || len(query) != 0 || content != "application/json" || json.Unmarshal(body, &payload) != nil || len(payload) != 8 || payload["limit"] != "200" || payload["keepEmptyRows"] != false || payload["returnPropertyQuota"] != false || !reflect.DeepEqual(requestedNames(t, payload["metrics"]), metricNames()) {
				t.Fatal("bounded report request changed")
			}
			dates := payload["dateRanges"].([]any)
			if len(dates) != 1 || !reflect.DeepEqual(dates[0], map[string]any{"startDate": f.request.Since, "endDate": f.request.Until}) {
				t.Fatal("report period changed")
			}
			dimensions := requestedNames(t, payload["dimensions"])
			orders := payload["orderBys"].([]any)
			if len(orders) != len(dimensions) {
				t.Fatal("stable order missing")
			}
			for i, order := range orders {
				if !reflect.DeepEqual(order, map[string]any{"dimension": map[string]any{"dimensionName": dimensions[i], "orderType": "ALPHANUMERIC"}, "desc": false}) {
					t.Fatal("stable dimension ordering changed")
				}
			}
			offset, err := strconv.Atoi(payload["offset"].(string))
			if err != nil || offset%reportLimit != 0 {
				t.Fatal("untrusted pagination offset")
			}
			count := 1
			if reflect.DeepEqual(dimensions, []string{"landingPage"}) {
				count = f.landingRows
			}
			response = observedFixture(dimensions, offset, count)
		default:
			t.Fatal("unapproved endpoint called")
		}
		if f.mutate != nil {
			return f.mutate(f.calls, path, response)
		}
		return response, nil
	})
	f.adapter = &Adapter{transport, transport, transport, transport, func() time.Time { return now }}
	return f
}

func TestAdapterFreshExactWorkspaceAndPeriodTotal(t *testing.T) {
	f := newAdapterFixture(t)
	f.landingRows = 401
	workspace, err := f.adapter.Fetch(context.Background(), f.credential, f.request)
	if err != nil || f.calls != 15 || f.metadataCalls != 5 || f.adminCalls != 2 || f.reportCalls != 7 || len(workspace.Landing.Rows) != 401 || len(workspace.Summary.Rows) != 1 || len(workspace.Summary.Dimensions) != 0 || workspace.Summary.Rows[0].Metrics[0] != "9007199254740993" || workspace.Daily.Rows[0].Metrics[3] != "1.3333333333333333" || workspace.Summary.Timezone != "Europe/Istanbul" || len(workspace.Definitions) != 4 {
		t.Fatal("exact complete workspace changed")
	}
	encoded, _ := json.Marshal(workspace)
	for _, private := range []string{"1234", "private-token", "private_key", "blockedReasons", "rowCount", "metadata", "properties/"} {
		if strings.Contains(string(encoded), private) {
			t.Fatal("private source context exposed")
		}
	}
	if _, err := NewAdapter(nil); err != ErrUnavailable {
		t.Fatal("unshared provider admission accepted")
	}
	if adapter, err := NewAdapter(providerhttp.NewAdmission()); err != nil || adapter == nil {
		t.Fatal("fixed-origin constructor unavailable")
	}
}

func TestAdapterDiscardsEveryLateFailureWithoutRetry(t *testing.T) {
	f := newAdapterFixture(t)
	for failedCall := 1; failedCall <= 13; failedCall++ {
		f.calls, f.metadataCalls, f.reportCalls, f.adminCalls = 0, 0, 0, 0
		f.mutate = func(call int, _ string, response []byte) ([]byte, error) {
			if call == failedCall {
				return []byte(`{"private":"synthetic.private-token"}`), errors.New("private synthetic credential error")
			}
			return response, nil
		}
		workspace, err := f.adapter.Fetch(context.Background(), f.credential, f.request)
		if err != ErrUnavailable || !reflect.DeepEqual(workspace, Workspace{}) || f.calls != failedCall {
			t.Fatalf("failure at call %d exposed partial results or retried", failedCall)
		}
	}
}

func TestAdapterRejectsPropertySchemaQualityAndPrivacyChanges(t *testing.T) {
	f := newAdapterFixture(t)
	cases := map[string]struct {
		call          int
		before, after string
	}{
		"wrong property":       {2, "properties/1234", "properties/5678"},
		"deleted property":     {2, `"name":`, `"deleteTime":"2026-10-04T00:00:00Z","name":`},
		"invalid timezone":     {2, "Europe/Istanbul", "Local"},
		"missing timezone":     {2, "timeZone", "unknown"},
		"duplicate timezone":   {2, `"timeZone":`, `"timeZone":"UTC","timeZone":`},
		"timezone changed":     {13, "Europe/Istanbul", "UTC"},
		"definition changed":   {5, "Synthetic contract description for activeUsers", "Changed description for activeUsers"},
		"sampled report":       {12, `"timeZone":`, `"subjectToThresholding":true,"timeZone":`},
		"wrong observed range": {6, "20261001", "20260930"},
		"landing query":        {12, "/synthetic/0000", "/synthetic/0000?email=private@example.com"},
		"landing email":        {12, "/synthetic/0000", "/private@example.com"},
		"landing absolute URL": {12, "/synthetic/0000", "https://store.example.com/"},
		"landing traversal":    {12, "/synthetic/0000", "//store.example.com/"},
		"wrong metric header":  {12, "TYPE_FLOAT", "TYPE_INTEGER"},
		"extra private field":  {12, `"rowCount":`, `"customer_email":"private@example.com","rowCount":`},
		"fractional count":     {12, "9007199254740993", "1.5"},
		"summary duplicates":   {4, `"rowCount":1`, `"rowCount":2`},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			f.calls, f.metadataCalls, f.reportCalls, f.adminCalls = 0, 0, 0, 0
			f.mutate = func(call int, _ string, raw []byte) ([]byte, error) {
				if call == test.call {
					if !strings.Contains(string(raw), test.before) {
						t.Fatal("adversarial mutation did not apply")
					}
					raw = []byte(strings.Replace(string(raw), test.before, test.after, 1))
				}
				return raw, nil
			}
			workspace, err := f.adapter.Fetch(context.Background(), f.credential, f.request)
			if err != ErrUnavailable || !reflect.DeepEqual(workspace, Workspace{}) || f.calls != test.call {
				t.Fatal("changed schema/context/quality/privacy returned a workspace")
			}
		})
	}
}

func TestAdapterPaginationIsCompleteStableAndBounded(t *testing.T) {
	f := newAdapterFixture(t)
	for _, count := range []int{0, 1, 200, 201, 999, 1000} {
		f.calls, f.metadataCalls, f.reportCalls, f.adminCalls = 0, 0, 0, 0
		f.landingRows = count
		workspace, err := f.adapter.Fetch(context.Background(), f.credential, f.request)
		if err != nil || workspace.Landing.Rows == nil || len(workspace.Landing.Rows) != count || f.reportCalls != 4+max(1, (count+reportLimit-1)/reportLimit) {
			t.Fatalf("complete bounded %d-row table unavailable", count)
		}
	}
	for _, change := range []string{"oversized", "changed total", "duplicate page", "reversed rows", "short page"} {
		t.Run(change, func(t *testing.T) {
			f.calls, f.metadataCalls, f.reportCalls, f.adminCalls = 0, 0, 0, 0
			f.landingRows = 201
			if change == "oversized" {
				f.landingRows = 1001
			}
			f.mutate = func(call int, _ string, raw []byte) ([]byte, error) {
				if call == 13 {
					switch change {
					case "changed total":
						raw = []byte(strings.Replace(string(raw), `"rowCount":201`, `"rowCount":200`, 1))
					case "duplicate page":
						raw = []byte(strings.Replace(string(raw), "/synthetic/0200", "/synthetic/0000", 1))
					case "short page":
						raw = observedFixture([]string{"landingPage"}, 0, 0)
					}
				}
				if call == 12 && change == "reversed rows" {
					raw = []byte(strings.ReplaceAll(strings.ReplaceAll(string(raw), "/synthetic/0000", "/synthetic/z000"), "/synthetic/0001", "/synthetic/a001"))
				}
				return raw, nil
			}
			workspace, err := f.adapter.Fetch(context.Background(), f.credential, f.request)
			if err != ErrUnavailable || !reflect.DeepEqual(workspace, Workspace{}) || f.calls > 13 {
				t.Fatal("incomplete/unstable table accepted or extra work scheduled")
			}
		})
	}
}

func TestAdapterCancellationExpiryAndInvalidContextPreventFurtherWork(t *testing.T) {
	f := newAdapterFixture(t)
	for failedCall := 1; failedCall <= 13; failedCall++ {
		ctx, cancel := context.WithCancel(context.Background())
		f.calls, f.metadataCalls, f.reportCalls, f.adminCalls = 0, 0, 0, 0
		f.mutate = func(call int, _ string, raw []byte) ([]byte, error) {
			if call == failedCall {
				cancel()
			}
			return raw, nil
		}
		workspace, err := f.adapter.Fetch(ctx, f.credential, f.request)
		cancel()
		if err != ErrUnavailable || !reflect.DeepEqual(workspace, Workspace{}) || f.calls != failedCall {
			t.Fatal("canceled work returned partial results or continued")
		}
	}
	f.calls = 0
	f.mutate = nil
	for _, invalid := range []Request{{}, {ClientID: f.request.ClientID, ConnectionID: f.request.ConnectionID, PropertyID: "1234/metadata", Since: f.request.Since, Until: f.request.Until}, {ClientID: f.request.ClientID, ConnectionID: f.request.ConnectionID, PropertyID: "1234", Since: "2026-09-01", Until: "2026-10-03"}} {
		if workspace, err := f.adapter.Fetch(context.Background(), f.credential, invalid); err != ErrUnavailable || !reflect.DeepEqual(workspace, Workspace{}) || f.calls != 0 {
			t.Fatal("invalid request performed provider work")
		}
	}
	if _, err := f.adapter.Fetch(nil, f.credential, f.request); err != ErrUnavailable || f.calls != 0 {
		t.Fatal("nil context performed provider work")
	}
	clockCalls := 0
	base := f.adapter.now()
	f.adapter.now = func() time.Time {
		clockCalls++
		if clockCalls > 2 {
			return base.Add(time.Hour)
		}
		return base
	}
	workspace, err := f.adapter.Fetch(context.Background(), f.credential, f.request)
	if err != ErrUnavailable || !reflect.DeepEqual(workspace, Workspace{}) || f.calls != 2 {
		t.Fatal("expired token used for additional report requests")
	}
}
