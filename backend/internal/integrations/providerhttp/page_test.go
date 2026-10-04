package providerhttp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"testing"
)

func TestCollectionPageRetainsOnlyBoundedCounts(t *testing.T) {
	f := tlsFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/store/wp-json/wc/v3/orders" || r.URL.Query().Get("page") != "1" || r.Header.Get("Authorization") != "Basic synthetic" {
			t.Error("compiled authenticated collection request changed")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-WP-Total", "500")
		w.Header().Set("X-WP-TotalPages", "5")
		w.Header().Set("Link", "https://foreign.example/private")
		_, _ = w.Write([]byte(`[{"id":1}]`))
	}), nil, nil, "shop.example.com")
	result, err := f.client.DoPage(context.Background(), "/wp-json/wc/v3/orders", url.Values{"page": {"1"}}, "Basic synthetic")
	if err != nil || result.Total != "500" || result.TotalPages != "5" || string(result.Body) != `[{"id":1}]` {
		t.Fatal("complete body/counts not retained")
	}
	defer clear(result.Body)
	for _, format := range []string{"%v", "%+v", "%#v", "%q", "%x"} {
		if fmt.Sprintf(format, result) != "<provider collection page>" {
			t.Fatal("private collection body formatted")
		}
	}
	if _, err := json.Marshal(result); err == nil {
		t.Fatal("private page serialized")
	}
}

func TestCollectionPageRejectsAmbiguousAndUnboundedCountsAtomically(t *testing.T) {
	for _, header := range []map[string][]string{
		{}, {"X-WP-Total": {"0"}}, {"X-WP-Total": {"0"}, "X-WP-TotalPages": {"0", "0"}},
		{"X-WP-Total": {"0", "0"}, "X-WP-TotalPages": {"0"}},
		{"X-WP-Total": {"0, 0"}, "X-WP-TotalPages": {"0"}},
		{"X-WP-Total": {"01"}, "X-WP-TotalPages": {"1"}},
		{"X-WP-Total": {"501"}, "X-WP-TotalPages": {"5"}},
		{"X-WP-Total": {"1000"}, "X-WP-TotalPages": {"5"}},
		{"X-WP-Total": {"1"}, "X-WP-TotalPages": {"6"}},
		{"X-WP-Total": {"1"}, "X-WP-TotalPages": {"01"}},
		{"X-WP-Total": {"Synthetic private header"}, "X-WP-TotalPages": {"1"}},
	} {
		f := tlsFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			for key, values := range header {
				for _, value := range values {
					w.Header().Add(key, value)
				}
			}
			_, _ = w.Write([]byte(`{"private":"synthetic"}`))
		}), nil, nil, "shop.example.com")
		result, err := f.client.DoPage(context.Background(), "/wp-json/wc/v3/orders", nil, "")
		if err != ErrUnavailable || !reflect.DeepEqual(result, PageResult{}) {
			t.Fatal("invalid header returned partial/private page")
		}
	}
}
