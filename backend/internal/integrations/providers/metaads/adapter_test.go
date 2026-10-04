package metaads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/integrations/providerhttp"
)

func requestFixture() Request {
	e := expectation()
	return Request{ClientID: e.ClientID, ConnectionID: e.ConnectionID, AccountID: e.AccountID, Since: e.Since, Until: e.Until}
}

func adapterFixture(t *testing.T) (*Adapter, *ReadToken, *[]string) {
	t.Helper()
	a, err := NewAdapter(providerhttp.NewAdmission())
	if err != nil {
		t.Fatal(err)
	}
	token, err := ParseReadToken([]byte("SyntheticReadTokenFixture123456"))
	if err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	a.now = func() time.Time { return time.Date(2026, 10, 4, 10, 0, 0, 123456000, time.UTC) }
	a.get = func(ctx context.Context, path, authorization string, query url.Values) ([]byte, error) {
		if ctx.Err() != nil || authorization != "Bearer SyntheticReadTokenFixture123456" || strings.Contains(query.Encode(), "SyntheticReadToken") {
			return nil, ErrInvalid
		}
		calls = append(calls, path)
		switch path {
		case "/v26.0/me/permissions":
			if !reflect.DeepEqual(query, url.Values{"fields": {"permission,status"}, "limit": {"100"}}) {
				return nil, ErrInvalid
			}
			return []byte(`{"data":[{"permission":"public_profile","status":"granted"},{"permission":"ads_read","status":"granted"}]}`), nil
		case "/v26.0/act_123456789":
			if query.Get("fields") != "id,account_id,currency,timezone_name" || len(query) != 1 {
				return nil, ErrInvalid
			}
			return []byte(`{"id":"act_123456789","account_id":"123456789","currency":"USD","timezone_name":"America/New_York"}`), nil
		case "/v26.0/act_123456789/insights":
			if query.Get("fields") != "account_id,account_currency,date_start,date_stop,spend,impressions,clicks" || query.Get("level") != "account" || query.Get("time_increment") != "1" || query.Get("limit") != "31" || query.Get("time_range") != `{"since":"2026-03-07","until":"2026-03-09"}` {
				return nil, ErrInvalid
			}
			switch query.Get("after") {
			case "":
				return continuing(row("2026-03-09", "2.00", "1", "1"), "fixture-after"), nil
			case "fixture-after":
				return page(row("2026-03-07", "1.00", "100", "1")), nil
			}
		}
		return nil, errors.New("synthetic unexpected provider path")
	}
	return a, token, &calls
}

func TestCompiledReadCollectionPermissionsContextPagingAndRedaction(t *testing.T) {
	a, token, calls := adapterFixture(t)
	value, err := a.FetchFenced(context.Background(), token, requestFixture(), func(context.Context) error { return nil })
	if err != nil || !ValidWorkspace(value, requestFixture()) || len(*calls) != 7 || value.Report.Totals.SpendDecimal != "3" || value.Report.Timezone != "America/New_York" || len(value.Report.Days) != 2 {
		t.Fatalf("collection failed: %v", err)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"123456789", "DO_NOT_RETURN", "fixture-after", "SyntheticReadToken", "synthetic.invalid", "2026-03-08"} {
		if strings.Contains(string(raw), private) {
			t.Fatal("private values or fabricated observations escaped")
		}
	}
	decoded, err := DecodeWorkspace(raw, requestFixture())
	if err != nil || !reflect.DeepEqual(decoded, value) {
		t.Fatal("strict report round trip failed")
	}
	if _, err := json.Marshal(token); !errors.Is(err, ErrInvalid) || strings.Contains(fmt.Sprintf("%+v %#v", token, token), "SyntheticReadToken") {
		t.Fatal("credential serialization or formatting escaped")
	}
}

func TestEveryRequestFailureAndFreshFenceFailureIsAtomic(t *testing.T) {
	for failAt := 1; failAt <= 7; failAt++ {
		t.Run(fmt.Sprint("request-", failAt), func(t *testing.T) {
			a, token, _ := adapterFixture(t)
			original, count := a.get, 0
			a.get = func(ctx context.Context, path, authorization string, query url.Values) ([]byte, error) {
				count++
				if count == failAt {
					return nil, errors.New("synthetic private token error")
				}
				return original(ctx, path, authorization, query)
			}
			w, err := a.FetchFenced(context.Background(), token, requestFixture(), func(context.Context) error { return nil })
			if !errors.Is(err, ErrInvalid) || !reflect.DeepEqual(w, Workspace{}) || count != failAt {
				t.Fatal("partial publication or provider retry")
			}
		})
	}
	for failAt := 1; failAt <= 8; failAt++ {
		t.Run(fmt.Sprint("fence-", failAt), func(t *testing.T) {
			a, token, calls := adapterFixture(t)
			count := 0
			w, err := a.FetchFenced(context.Background(), token, requestFixture(), func(context.Context) error {
				count++
				if count == failAt {
					return errors.New("synthetic revoked access")
				}
				return nil
			})
			if !errors.Is(err, ErrInvalid) || !reflect.DeepEqual(w, Workspace{}) || len(*calls) != failAt-1 {
				t.Fatal("request or publication followed a lost fence")
			}
		})
	}
}

func TestCollectionRejectsScopeIdentityContextChangesAndIncompletePages(t *testing.T) {
	cases := []struct {
		name   string
		call   int
		change func([]byte) []byte
	}{
		{"missing ads_read", 1, func(b []byte) []byte { return []byte(`{"data":[{"permission":"ads_management","status":"granted"}]}`) }},
		{"declined", 1, func(b []byte) []byte {
			return []byte(strings.Replace(string(b), `"ads_read","status":"granted"`, `"ads_read","status":"declined"`, 1))
		}},
		{"expanded permission", 1, func(b []byte) []byte {
			return []byte(`{"data":[{"permission":"ads_read","status":"granted","token":"private"}]}`)
		}},
		{"foreign account", 2, func(b []byte) []byte { return []byte(strings.ReplaceAll(string(b), "123456789", "123456780")) }},
		{"expanded account", 2, func(b []byte) []byte {
			return []byte(strings.Replace(string(b), `"currency":`, `"name":"private","currency":`, 1))
		}},
		{"invalid timezone", 2, func(b []byte) []byte { return []byte(strings.Replace(string(b), "America/New_York", "Local", 1)) }},
		{"currency mismatch", 3, func(b []byte) []byte { return []byte(strings.ReplaceAll(string(b), "USD", "EUR")) }},
		{"changed first page", 5, func(b []byte) []byte { return append(b, ' ') }},
		{"changed timezone", 6, func(b []byte) []byte { return []byte(strings.Replace(string(b), "America/New_York", "UTC", 1)) }},
		{"revoked provider scope", 7, func(b []byte) []byte { return []byte(`{"data":[{"permission":"ads_read","status":"expired"}]}`) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a, token, _ := adapterFixture(t)
			original, count := a.get, 0
			a.get = func(ctx context.Context, path, authorization string, query url.Values) ([]byte, error) {
				count++
				b, err := original(ctx, path, authorization, query)
				if count == c.call {
					b = c.change(b)
				}
				return b, err
			}
			w, err := a.FetchFenced(context.Background(), token, requestFixture(), func(context.Context) error { return nil })
			if !errors.Is(err, ErrInvalid) || !reflect.DeepEqual(w, Workspace{}) {
				t.Fatal("invalid provider collection escaped")
			}
		})
	}
}

func TestTokenBoundsAndStoredMetricIntegrity(t *testing.T) {
	for _, raw := range []string{"", "short", " leadingSyntheticToken", "SyntheticTokenTrailing ", "SyntheticToken\nPrivate", strings.Repeat("a", 4097), "SyntheticToken?access_token=private"} {
		if _, err := ParseReadToken([]byte(raw)); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid Bearer token accepted")
		}
	}
	a, token, _ := adapterFixture(t)
	w, err := a.FetchFenced(context.Background(), token, requestFixture(), func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(w)
	bad := [][]byte{
		[]byte(strings.Replace(string(raw), `"impressions":"101"`, `"impressions":"102"`, 1)),
		[]byte(strings.Replace(string(raw), `"ctr_percent":"1.980198"`, `"ctr_percent":null`, 1)),
		[]byte(strings.Replace(string(raw), `"report":`, `"access_token":"private","report":`, 1)),
		[]byte(strings.Replace(string(raw), `"currency":"USD"`, `"currency":"USD","currency":"USD"`, 1)),
		[]byte(strings.Replace(string(raw), `"date":"2026-03-07"`, `"date":"2026-03-07","name":"private"`, 1)),
		[]byte(strings.Replace(string(raw), `"collected_through":"2026-10-04T10:00:00.123456Z"`, `"collected_through":"2026-10-04T10:02:02Z"`, 1)),
	}
	for _, raw := range bad {
		if value, err := DecodeWorkspace(raw, requestFixture()); !errors.Is(err, ErrInvalid) || !reflect.DeepEqual(value, Workspace{}) {
			t.Fatal("corrupt or expanded stored report escaped")
		}
	}
}

func TestCompiledPaginationStopsAtFourPagesAndCannotCycleOrContinueAfterCancel(t *testing.T) {
	for _, mode := range []string{"complete", "fifth-page", "cycle"} {
		t.Run(mode, func(t *testing.T) {
			a, token, calls := adapterFixture(t)
			original, insights := a.get, 0
			r := requestFixture()
			r.Until = "2026-03-10"
			a.get = func(ctx context.Context, path, auth string, query url.Values) ([]byte, error) {
				if !strings.HasSuffix(path, "/insights") {
					return original(ctx, path, auth, query)
				}
				*calls = append(*calls, path)
				insights++
				index := 0
				if query.Get("after") != "" {
					for i := 1; i < 4; i++ {
						if query.Get("after") == fmt.Sprint("cursor-", i) {
							index = i
						}
					}
					if index == 0 {
						return nil, ErrInvalid
					}
				}
				if auth != "Bearer SyntheticReadTokenFixture123456" || query.Get("time_range") != `{"since":"2026-03-07","until":"2026-03-10"}` {
					return nil, ErrInvalid
				}
				day := row(fmt.Sprintf("2026-03-%02d", 7+index), "1", "1", "1")
				if index == 3 && mode == "complete" {
					return page(day), nil
				}
				cursor := fmt.Sprint("cursor-", index+1)
				if index == 1 && mode == "cycle" {
					cursor = "cursor-1"
				}
				return continuing(day, cursor), nil
			}
			w, err := a.FetchFenced(context.Background(), token, r, func(context.Context) error { return nil })
			if mode == "complete" {
				if err != nil || len(w.Report.Days) != 4 || insights != 5 || len(*calls) != 9 {
					t.Fatal("bounded complete collection failed", err)
				}
			} else if !errors.Is(err, ErrInvalid) || !reflect.DeepEqual(w, Workspace{}) || insights > 4 {
				t.Fatal("pagination exceeded bounds or published partial data")
			}
		})
	}
	a, token, calls := adapterFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	original := a.get
	a.get = func(ctx context.Context, path, auth string, query url.Values) ([]byte, error) {
		b, err := original(ctx, path, auth, query)
		cancel()
		return b, err
	}
	w, err := a.FetchFenced(ctx, token, requestFixture(), func(context.Context) error { return nil })
	if !errors.Is(err, ErrInvalid) || !reflect.DeepEqual(w, Workspace{}) || len(*calls) != 1 {
		t.Fatal("collection continued after cancellation")
	}
}
