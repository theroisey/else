//go:build integration

package integration

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/overview"
)

const capacityClients = 500
const capacityRequestsPerWorker = 10
const capacityBudget = 2 * time.Second

var capacityRoutes = []string{"directory", "directory_max", "overview", "tasks", "reminders", "billing", "pricing"}

// API-only closed-loop read and mixed readiness, not a deployed/browser SLA.
func TestCapacityCompiledAPIRepresentativeReads(t *testing.T) {
	binary := buildCompiledAPI(t)
	f := administrationFixtureFromIdentity(t, identityFixtureFromBase(t, newFixtureWithTimeout(t, 3*time.Minute)))
	ids := seedCapacityData(t, f)
	role, err := f.accounts.CreateRole(correlation.New(f.base.ctx), f.actor, "Synthetic capacity read only", []authorization.Permission{
		authorization.ClientsView, authorization.TasksView, authorization.RemindersView,
		authorization.BillingView, authorization.PricingView, authorization.ActivityView,
	})
	if err != nil {
		t.Fatal("capacity reader role setup failed")
	}
	sessions := make([]identity.LoginResult, 100)
	for i := range sessions {
		email := fmt.Sprintf("capacity.%03d@example.com", i)
		user := f.user(t, email)
		f.assignment(t, user.ID, role.ID)
		sessions[i], err = f.service.Login(correlation.New(f.base.ctx), email, bootstrapPassword)
		if err != nil {
			t.Fatal("capacity independent session setup failed")
		}
	}
	api := startCompiledAPI(t, f, binary)
	transport := &http.Transport{MaxIdleConns: 100, MaxIdleConnsPerHost: 100, MaxConnsPerHost: 100}
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	defer func() {
		api.Close()
		for _, session := range sessions {
			if strings.Contains(api.Logs.String(), session.Token) || strings.Contains(api.Logs.String(), session.CSRF) {
				t.Error("capacity logs exposed session material")
			}
		}
		if strings.Contains(api.Logs.String(), f.runtime.Config().ConnConfig.Password) {
			t.Error("capacity logs exposed runtime credential")
		}
	}()
	var pgVersion string
	if f.admin.QueryRow(f.base.ctx, "SHOW server_version").Scan(&pgVersion) != nil {
		t.Fatal("capacity runtime version unavailable")
	}
	t.Logf("synthetic clients=%d (+2 base) tasks=50000 reminders=20000 collections=10000 pricing_sheets=5000 independent_sessions=100 pool=10 go=%s postgres=%s gomaxprocs=%d", capacityClients, runtime.Version(), pgVersion, runtime.GOMAXPROCS(0))
	before := capacityState(t, f)
	if !reflect.DeepEqual(before[:12], []int64{502, 502, 50000, 50000, 20000, 20000, 10000, 10000, 5000, 5000, 5000, 5000}) {
		t.Fatal("capacity synthetic dataset counts/revisions differ")
	}
	// Record cold requests separately, then warm ordinary routes/connections.
	for i, route := range capacityRoutes {
		duration, ok := capacityRead(api, client, sessions[0], ids[i], route)
		t.Logf("cold route=%s complete_response_ms=%.3f valid=%t", route, float64(duration)/float64(time.Millisecond), ok)
		if !ok {
			t.Fatalf("capacity cold response invalid: %s", route)
		}
	}
	for i := 0; i < 30; i++ {
		if _, ok := capacityRead(api, client, sessions[i], ids[i], capacityRoutes[i%len(capacityRoutes)]); !ok {
			t.Fatal("capacity warm response invalid")
		}
	}
	for _, concurrency := range []int{20, 50, 100} {
		t.Run(fmt.Sprintf("users_%d", concurrency), func(t *testing.T) {
			type measurement struct {
				route    string
				duration time.Duration
				ok       bool
			}
			results := make(chan measurement, concurrency*capacityRequestsPerWorker)
			start := make(chan struct{})
			var workers sync.WaitGroup
			for worker := 0; worker < concurrency; worker++ {
				workers.Add(1)
				go func(worker int) {
					defer workers.Done()
					<-start
					for request := 0; request < capacityRequestsPerWorker; request++ {
						route := capacityRoutes[(worker+request)%len(capacityRoutes)]
						id := ids[(worker*capacityRequestsPerWorker+request)%len(ids)]
						duration, ok := capacityRead(api, client, sessions[worker], id, route)
						results <- measurement{route, duration, ok}
					}
				}(worker)
			}
			stamp := time.Now()
			close(start)
			workers.Wait()
			close(results)
			elapsed := time.Since(stamp)
			observations := map[string][]time.Duration{}
			count, failures := 0, 0
			for result := range results {
				count++
				if !result.ok {
					failures++
				}
				observations[result.route] = append(observations[result.route], result.duration)
			}
			t.Logf("workers=%d requests=%d invalid_or_timeout=%d elapsed_ms=%.3f throughput_rps=%.2f", concurrency, count, failures, float64(elapsed)/float64(time.Millisecond), float64(count)/elapsed.Seconds())
			if count != concurrency*capacityRequestsPerWorker || failures != 0 {
				t.Errorf("capacity requests incomplete/invalid: count=%d failures=%d", count, failures)
			}
			for _, route := range capacityRoutes {
				values := observations[route]
				sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
				if len(values) == 0 {
					t.Errorf("capacity route unmeasured: %s", route)
					continue
				}
				percentile := func(n int) time.Duration { return values[(len(values)*n+99)/100-1] }
				p95 := percentile(95)
				t.Logf("route=%s n=%d p50_ms=%.3f p95_ms=%.3f p99_ms=%.3f max_ms=%.3f", route, len(values), float64(percentile(50))/float64(time.Millisecond), float64(p95)/float64(time.Millisecond), float64(percentile(99))/float64(time.Millisecond), float64(values[len(values)-1])/float64(time.Millisecond))
				if p95 > capacityBudget {
					t.Errorf("capacity P95 exceeds 2-second API budget: %s", route)
				}
			}
		})
	}
	if !reflect.DeepEqual(before, capacityState(t, f)) {
		t.Error("capacity reads changed domain/audit/session state")
	}
	t.Run("mixed_two_api_two_worker_replicas", func(t *testing.T) {
		capacityMixed(t, f, binary, api, client, sessions, ids)
	})
}

func capacityRead(api *compiledAPI, client *http.Client, session identity.LoginResult, id, route string) (time.Duration, bool) {
	path := "/api/v1/clients/" + id + "/" + route + "?limit=25"
	isDirectory := route == "directory" || route == "directory_max"
	if route == "directory" {
		path = "/api/v1/clients?q=Synthetic%20capacity"
	}
	if route == "directory_max" {
		path = "/api/v1/clients?limit=100&q=Synthetic%20capacity"
	}
	if route == "overview" {
		path = "/api/v1/clients/" + id + "/overview"
	}
	request, err := http.NewRequestWithContext(api.Context, http.MethodGet, api.Origin+path, nil)
	if err != nil {
		return 0, false
	}
	request.AddCookie(&http.Cookie{Name: "else_session", Value: session.Token})
	stamp := time.Now()
	response, err := client.Do(request)
	if err != nil {
		return time.Since(stamp), false
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	duration := time.Since(stamp)
	if err != nil || len(body) > 65536 || response.StatusCode != 200 || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Content-Type") != "application/json; charset=utf-8" {
		fmt.Printf("capacity response flags status=%d bytes=%d read_ok=%t cache_ok=%t json_media_ok=%t\n", response.StatusCode, len(body), err == nil, response.Header.Get("Cache-Control") == "no-store", response.Header.Get("Content-Type") == "application/json; charset=utf-8")
		return duration, false
	}
	if route == "overview" {
		var value struct {
			Data overview.Overview `json:"data"`
		}
		if json.Unmarshal(body, &value) != nil {
			return duration, false
		}
		v := value.Data
		if v.Client.ID != id || v.Finance == nil || v.Tasks == nil || v.Reminders == nil || v.Activity == nil || len(v.Finance.Currencies) != 1 {
			return duration, false
		}
		money := v.Finance.Currencies[0]
		if money.Currency != "USD" || money.AmountMinor != "200000" || money.PaidMinor != "0" || money.OutstandingMinor != "200000" {
			return duration, false
		}
		if len(v.Tasks.Overdue.Items) != 5 || !v.Tasks.Overdue.HasMore || len(v.Reminders.Due.Items) != 5 || !v.Reminders.Due.HasMore || len(v.Activity.Items) > 5 {
			return duration, false
		}
		return duration, true
	}
	var page struct {
		Data []struct {
			ID       string `json:"id"`
			ClientID string `json:"client_id"`
		} `json:"data"`
		Page struct {
			Limit      int     `json:"limit"`
			NextCursor *string `json:"next_cursor"`
		} `json:"page"`
	}
	expectedRows, expectedLimit, needCursor := 25, 25, true
	switch route {
	case "directory_max":
		expectedRows, expectedLimit = 100, 100
	case "billing":
		expectedRows, needCursor = 20, false
	case "pricing":
		expectedRows, needCursor = 10, false
	}
	if json.Unmarshal(body, &page) != nil || len(page.Data) != expectedRows || page.Page.Limit != expectedLimit || (needCursor && (page.Page.NextCursor == nil || *page.Page.NextCursor == "")) || (!needCursor && page.Page.NextCursor != nil) {
		fmt.Printf("capacity page flags rows=%d limit=%d cursor_present=%t\n", len(page.Data), page.Page.Limit, page.Page.NextCursor != nil)
		return duration, false
	}
	seen := map[string]bool{}
	for _, row := range page.Data {
		if row.ID == "" || seen[row.ID] || (!isDirectory && row.ClientID != id) {
			return duration, false
		}
		seen[row.ID] = true
	}
	return duration, true
}

func capacityState(t *testing.T, f *administrationFixture) []int64 {
	t.Helper()
	var values []int64
	for _, table := range []string{"clients", "tasks", "reminders", "collections", "pricing_sheets"} {
		var count, sum int64
		if f.admin.QueryRow(f.base.ctx, "SELECT count(*),coalesce(sum(revision),0) FROM app."+table).Scan(&count, &sum) != nil {
			t.Fatal("capacity domain snapshot failed")
		}
		values = append(values, count, sum)
	}
	for _, table := range []string{"pricing_versions", "pricing_lines", "audit_events", "sessions"} {
		var count int64
		if f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app."+table).Scan(&count) != nil {
			t.Fatal("capacity history snapshot failed")
		}
		values = append(values, count)
	}
	return values
}

func seedCapacityData(t *testing.T, f *administrationFixture) []string {
	t.Helper()
	ids := make([]string, capacityClients)
	for i := range ids {
		ids[i] = fmt.Sprintf("c5000000-0000-4000-8000-%012d", i+1)
	}
	tx, err := f.admin.Begin(f.base.ctx)
	if err != nil {
		t.Fatal("capacity seed transaction unavailable")
	}
	defer tx.Rollback(f.base.ctx)
	queries := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO app.client_scopes SELECT unnest($1::uuid[])`, []any{ids}},
		{`INSERT INTO app.clients(id,name) SELECT id,'Synthetic capacity client '||ord FROM unnest($1::uuid[]) WITH ORDINALITY x(id,ord)`, []any{ids}},
		{`INSERT INTO app.tasks(id,client_id,created_by,title,status,priority,due_at)
 SELECT gen_random_uuid(),id,$2::uuid,'Synthetic capacity task '||i,'todo','high',statement_timestamp()-i*interval '1 hour' FROM unnest($1::uuid[]) id CROSS JOIN generate_series(1,100)i`, []any{ids, f.actor}},
		{`INSERT INTO app.reminders(id,client_id,created_by,owner_id,title,status,scheduled_at,scheduled_local,timezone,utc_offset_seconds)
 SELECT gen_random_uuid(),id,$2::uuid,$2::uuid,'Synthetic capacity reminder '||i,'pending',v,to_char(v AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),'UTC',0
	FROM unnest($1::uuid[]) id CROSS JOIN generate_series(1,40)i CROSS JOIN LATERAL(SELECT statement_timestamp()-i*interval '1 hour' v)z`, []any{ids, f.actor}},
		{`INSERT INTO app.collections(id,client_id,created_by,description,amount_minor,currency,currency_exponent,due_date)
 SELECT gen_random_uuid(),id,$2::uuid,'Synthetic capacity collection '||i,10000,'USD',2,'2000-01-01' FROM unnest($1::uuid[])id CROSS JOIN generate_series(1,20)i`, []any{ids, f.actor}},
		{`CREATE TEMP TABLE capacity_pricing ON COMMIT DROP AS SELECT gen_random_uuid() sheet_id,gen_random_uuid() version_id,id client_id FROM unnest($1::uuid[]) id CROSS JOIN generate_series(1,10)i`, []any{ids}},
		{`INSERT INTO app.pricing_sheets(id,client_id,currency,currency_exponent,revision) SELECT sheet_id,client_id,'USD',2,1 FROM capacity_pricing`, nil},
		{`INSERT INTO app.pricing_versions(id,sheet_id,client_id,currency,revision,title,note,effective_from,created_by,base_minor,discount_minor,net_minor,tax_minor,total_minor)
 SELECT version_id,sheet_id,client_id,'USD',1,'Synthetic capacity agreement','','2000-01-01',$1::uuid,1000,0,1000,0,1000 FROM capacity_pricing`, []any{f.actor}},
		{`INSERT INTO app.pricing_lines(version_id,position,description,kind,frequency,quantity_micros,unit_price_minor,discount_bps,tax_bps,base_minor,discount_minor,net_minor,tax_minor,total_minor)
 SELECT version_id,1,'Synthetic capacity service','recurring','monthly',1000000,1000,0,0,1000,0,1000,0,1000 FROM capacity_pricing`, nil},
	}
	for i, step := range queries {
		if _, err := tx.Exec(f.base.ctx, step.query, step.args...); err != nil {
			t.Fatalf("capacity synthetic seed failed at stage %d", i+1)
		}
	}
	if tx.Commit(f.base.ctx) != nil {
		t.Fatal("capacity synthetic seed invariant commit failed")
	}
	for _, table := range []string{"clients", "tasks", "reminders", "collections", "pricing_sheets", "pricing_versions", "pricing_lines"} {
		if _, err := f.admin.Exec(f.base.ctx, "ANALYZE app."+table); err != nil {
			t.Fatal("capacity fixture statistics failed")
		}
	}
	return ids
}
