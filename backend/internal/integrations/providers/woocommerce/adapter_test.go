package woocommerce

import (
	"context"
	"encoding/base64"
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

type collectionCall struct {
	path  string
	query url.Values
}
type syntheticCollection struct {
	orders, refunds       int
	calls                 []collectionCall
	failAt                int
	modify                func(int, *providerhttp.PageResult)
	orderRows, refundRows []map[string]any
}

func collectorFixture(t *testing.T, orders, refunds int) (*Adapter, *ReadKey, *syntheticCollection) {
	t.Helper()
	f := &syntheticCollection{orders: orders, refunds: refunds}
	for i := 1; i <= orders; i++ {
		f.orderRows = append(f.orderRows, map[string]any{"id": i, "status": "pending", "currency": "USD", "date_created_gmt": "2026-10-01T00:00:00", "total": "100.000000", "refunds": []any{}, "line_items": []any{map[string]any{"id": 10000 + i, "product_id": 3, "variation_id": 0, "quantity": 2, "total": "90.000000", "total_tax": "10.000000"}}})
	}
	for i := 1; i <= refunds; i++ {
		f.refundRows = append(f.refundRows, map[string]any{"id": 20000 + i, "parent_id": i, "date_created_gmt": "2026-10-01T12:00:00", "amount": "1.000000"})
	}
	key, err := ParseReadKey([]byte(readKeyFixture()))
	if err != nil {
		t.Fatal("fixture key invalid")
	}
	return &Adapter{client: f, now: func() time.Time { return time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC) }}, key, f
}

func (f *syntheticCollection) DoPage(ctx context.Context, path string, query url.Values, authorization string) (providerhttp.PageResult, error) {
	copyQuery := url.Values{}
	for key, values := range query {
		copyQuery[key] = append([]string{}, values...)
	}
	f.calls = append(f.calls, collectionCall{path, copyQuery})
	number := len(f.calls)
	if ctx.Err() != nil || f.failAt == number {
		return providerhttp.PageResult{}, errors.New("synthetic private provider error")
	}
	wantedAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ck_"+strings.Repeat("a", 40)+":cs_"+strings.Repeat("b", 40)))
	if authorization != wantedAuth {
		return providerhttp.PageResult{}, errors.New("synthetic wrong credential header")
	}
	var rows []map[string]any
	var total, pages int
	if query.Get("include") != "" {
		if path != ordersPath || query.Get("_fields") != "id,currency" || query.Get("after") != "" || query.Get("before") != "" || query.Get("per_page") != "50" || query.Get("page") != "1" {
			return providerhttp.PageResult{}, ErrUnavailable
		}
		ids := strings.Split(query.Get("include"), ",")
		for _, id := range ids {
			value, err := strconv.Atoi(id)
			if err != nil {
				return providerhttp.PageResult{}, ErrUnavailable
			}
			rows = append(rows, map[string]any{"id": value, "currency": "USD"})
		}
		total = len(ids)
		pages = 1
	} else {
		if query.Get("after") != "2026-09-30T23:59:59Z" || query.Get("before") != expectation().End || query.Get("dates_are_gmt") != "true" || query.Get("dp") != "6" || query.Get("orderby") != "id" || query.Get("order") != "asc" || query.Get("per_page") != "100" {
			return providerhttp.PageResult{}, ErrUnavailable
		}
		n, err := strconv.Atoi(query.Get("page"))
		if err != nil || n < 1 {
			return providerhttp.PageResult{}, ErrUnavailable
		}
		var source []map[string]any
		switch path {
		case ordersPath:
			if query.Get("_fields") != orderFields {
				return providerhttp.PageResult{}, ErrUnavailable
			}
			source = f.orderRows
			total = f.orders
		case refundsPath:
			if query.Get("_fields") != refundFields {
				return providerhttp.PageResult{}, ErrUnavailable
			}
			source = f.refundRows
			total = f.refunds
		default:
			return providerhttp.PageResult{}, ErrUnavailable
		}
		start := min((n-1)*100, len(source))
		end := min(n*100, len(source))
		rows = source[start:end]
		pages = (total + 99) / 100
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	body, _ := json.Marshal(rows)
	result := providerhttp.PageResult{Body: body, Total: strconv.Itoa(total), TotalPages: strconv.Itoa(pages)}
	if f.modify != nil {
		f.modify(number, &result)
	}
	return result, nil
}

func TestCompleteWooCommerceCollectionRequestsAndExactWorkspace(t *testing.T) {
	a, key, f := collectorFixture(t, 1, 1)
	w, err := a.Fetch(context.Background(), key, expectation())
	if err != nil || w.Orders.GrandTotalMinor != "10000" || w.Orders.LifetimeRefundMinor != "0" || w.Refunds.AmountMinor != "100" || len(w.Products.Products) != 1 || w.Products.Products[0].LineGrandMinor != "10000" || len(f.calls) != 5 {
		t.Fatal("complete observed collection failed")
	}
	if w.Orders.ClientID != expectation().ClientID || w.Products.ConnectionID != expectation().ConnectionID || w.CollectedFrom.Location() != time.UTC || w.CollectedThrough.Before(w.CollectedFrom) {
		t.Fatal("workspace binding/interval changed")
	}
	encoded, _ := json.Marshal(w)
	for _, private := range []string{"consumer_key", "consumer_secret", "provider_account", "shop_url", "customer", "billing", "payment", "reason", "ck_", "cs_"} {
		if strings.Contains(string(encoded), private) {
			t.Fatal("private values retained in measured workspace")
		}
	}
	for _, call := range f.calls {
		for key := range call.query {
			if strings.Contains(key, "consumer") || strings.Contains(key, "token") {
				t.Fatal("credential entered query")
			}
		}
	}
	for _, format := range []string{"%v", "%+v", "%#v", "%x"} {
		if fmt.Sprintf(format, a) != "<WooCommerce collector>" {
			t.Fatal("collector formatted private origin")
		}
	}
}

func TestWooCommerceCompletePaginationAndBoundedParentBatches(t *testing.T) {
	for _, count := range []int{0, 1, 100, 101, 499, 500} {
		a, key, f := collectorFixture(t, count, count)
		w, err := a.Fetch(context.Background(), key, expectation())
		if err != nil || len(w.Orders.Orders) != count || len(w.Refunds.Refunds) != count || w.Orders.GrandTotalMinor != strconv.Itoa(count*10000) || w.Refunds.AmountMinor != strconv.Itoa(count*100) {
			t.Fatalf("complete pagination failed for %d", count)
		}
		for _, call := range f.calls {
			if raw := call.query.Get("include"); raw != "" && len(strings.Split(raw, ",")) > 50 {
				t.Fatal("unbounded parent request")
			}
		}
	}
	for _, count := range []int{501, 600} {
		a, key, _ := collectorFixture(t, count, count)
		w, err := a.Fetch(context.Background(), key, expectation())
		assertEmptyWorkspace(t, w, err)
	}
}

func TestWooCommerceEveryRequestFailureAndFenceIsAtomic(t *testing.T) {
	a, key, f := collectorFixture(t, 500, 500)
	if _, err := a.Fetch(context.Background(), key, expectation()); err != nil {
		t.Fatal("fixture complete collection failed")
	}
	requests := len(f.calls)
	if requests != 22 {
		t.Fatal("bounded request sequence changed")
	}
	for fail := 1; fail <= requests; fail++ {
		a, key, f := collectorFixture(t, 500, 500)
		f.failAt = fail
		w, err := a.Fetch(context.Background(), key, expectation())
		assertEmptyWorkspace(t, w, err)
		if len(f.calls) != fail {
			t.Fatal("failed provider request replayed")
		}
		a, key, f = collectorFixture(t, 500, 500)
		checks := 0
		w, err = a.FetchFenced(context.Background(), key, expectation(), func(context.Context) bool { checks++; return checks != fail })
		assertEmptyWorkspace(t, w, err)
		if len(f.calls) != fail-1 {
			t.Fatal("request executed after revoked fence")
		}
	}
}

func TestWooCommerceRejectsChangedPrivateWrongCurrencyAndParentReports(t *testing.T) {
	for _, tc := range []struct {
		at     int
		change func(*providerhttp.PageResult)
	}{
		{1, func(r *providerhttp.PageResult) { r.Total = "01" }},
		{1, func(r *providerhttp.PageResult) { r.TotalPages = "2" }},
		{1, func(r *providerhttp.PageResult) { r.Body = []byte("[]") }},
		{1, func(r *providerhttp.PageResult) {
			r.Body = []byte(strings.Replace(string(r.Body), `"currency":"USD"`, `"currency":"EUR"`, 1))
		}},
		{1, func(r *providerhttp.PageResult) {
			r.Body = []byte(strings.Replace(string(r.Body), `"status":"pending"`, `"status":"pending","billing":{"private":"synthetic"}`, 1))
		}},
		{1, func(r *providerhttp.PageResult) {
			r.Body = []byte(strings.Replace(string(r.Body), `2026-10-01T00:00:00`, `2026-09-30T23:59:59`, 1))
		}},
		{2, func(r *providerhttp.PageResult) {
			r.Body = []byte(strings.Replace(string(r.Body), `"amount":"1.000000"`, `"amount":"1.001000"`, 1))
		}},
		{3, func(r *providerhttp.PageResult) { r.Total = "0"; r.TotalPages = "0"; r.Body = []byte("[]") }},
		{3, func(r *providerhttp.PageResult) { r.Body = []byte(`[{"id":2,"currency":"USD"}]`) }},
		{3, func(r *providerhttp.PageResult) { r.Body = []byte(`[{"id":1,"currency":"EUR"}]`) }},
		{3, func(r *providerhttp.PageResult) { r.Body = []byte(`[{"id":1,"currency":"USD","customer_id":99}]`) }},
		{4, func(r *providerhttp.PageResult) { r.Total = "2" }},
		{4, func(r *providerhttp.PageResult) {
			r.Body = []byte(strings.Replace(string(r.Body), `"total":"100.000000"`, `"total":"99.000000"`, 1))
		}},
		{5, func(r *providerhttp.PageResult) {
			r.Body = []byte(strings.Replace(string(r.Body), `"amount":"1.000000"`, `"amount":"0.000000"`, 1))
		}},
	} {
		a, key, f := collectorFixture(t, 1, 1)
		f.modify = func(n int, r *providerhttp.PageResult) {
			if n == tc.at {
				tc.change(r)
			}
		}
		w, err := a.Fetch(context.Background(), key, expectation())
		assertEmptyWorkspace(t, w, err)
	}
}

func TestWooCommerceConstructorAndCancellationDoNotActivateAccess(t *testing.T) {
	for _, origin := range []string{"http://shop.example.com", "https://127.0.0.1", "https://shop.example.com:443", "https://shop.example.com/?consumer_key=private", "https://shop.example.com/../store"} {
		if a, err := NewAdapter(origin, providerhttp.NewAdmission()); err != ErrUnavailable || a != nil {
			t.Fatal("untrusted origin accepted")
		}
	}
	if a, err := NewAdapter("https://shop.example.com/store", providerhttp.NewAdmission()); err != nil || a == nil {
		t.Fatal("canonical stored origin rejected")
	}
	a, key, f := collectorFixture(t, 1, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w, err := a.Fetch(ctx, key, expectation())
	assertEmptyWorkspace(t, w, err)
	if len(f.calls) != 0 {
		t.Fatal("canceled collection requested data")
	}
	w, err = a.FetchFenced(context.Background(), key, expectation(), nil)
	assertEmptyWorkspace(t, w, err)
	ctx, cancel = context.WithCancel(context.Background())
	w, err = a.FetchFenced(ctx, key, expectation(), func(context.Context) bool { cancel(); return true })
	assertEmptyWorkspace(t, w, err)
	if len(f.calls) != 0 {
		t.Fatal("cancellation after fence requested data")
	}
	e := expectation()
	e.PerPage = 50
	w, err = a.Fetch(context.Background(), key, e)
	assertEmptyWorkspace(t, w, err)
}

func assertEmptyWorkspace(t *testing.T, w Workspace, err error) {
	t.Helper()
	if err != ErrUnavailable || !reflect.DeepEqual(w, Workspace{}) {
		t.Fatal("partial/private collection result escaped")
	}
}
