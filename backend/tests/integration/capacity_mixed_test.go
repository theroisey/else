//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/analytics"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/database"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/integrations/providers/ga4"
	"github.com/theroisey/else/backend/internal/integrations/providers/metaads"
	"github.com/theroisey/else/backend/internal/integrations/providers/woocommerce"
	"github.com/theroisey/else/backend/internal/tasks"
)

type capacityReport struct {
	Client, Connection, Provider, Account string
	Workspace                             json.RawMessage
}

// A short synthetic mixed burst. Two audited live leases represent external
// collection; actual workers exercise global admission, never a vendor network.
func capacityMixed(t *testing.T, f *administrationFixture, binary string, first *compiledAPI, client *http.Client, sessions []identity.LoginResult, ids []string) {
	t.Helper()
	ctx := correlation.New(f.base.ctx)
	reader, err := f.accounts.CreateRole(ctx, f.actor, "Synthetic capacity report reader", []authorization.Permission{authorization.AnalyticsView})
	if err != nil {
		t.Fatal("mixed report role unavailable")
	}
	writer, err := f.accounts.CreateRole(ctx, f.actor, "Synthetic capacity task writer", []authorization.Permission{authorization.TasksManage})
	if err != nil {
		t.Fatal("mixed write role unavailable")
	}
	for i, session := range sessions {
		f.assignment(t, session.Session.User.ID, reader.ID)
		if i < 10 {
			f.assignment(t, session.Session.User.ID, writer.ID)
		}
	}
	reports := seedCapacityReports(t, f, ids)
	capacityPlans(t, f, ids[0], reports[ids[0]+"meta_ads"].Connection)
	second := startCompiledAPI(t, f, binary)
	defer func() {
		first.Close()
		second.Close()
		for _, api := range []*compiledAPI{first, second} {
			for _, session := range sessions {
				if strings.Contains(api.Logs.String(), session.Token) || strings.Contains(api.Logs.String(), session.CSRF) {
					t.Error("mixed API logs exposed session material")
				}
			}
			for _, private := range []string{marketingToken, "PRIVATE KEY", f.runtime.Config().ConnConfig.Password} {
				if strings.Contains(api.Logs.String(), private) {
					t.Error("mixed API logs exposed private material")
				}
			}
		}
	}()
	ring := syntheticRing(t, "synthetic-capacity", 0x58)
	service, err := analytics.NewService(f.runtime, ring)
	if err != nil {
		t.Fatal("mixed provider service unavailable")
	}
	meta, err := service.CreateMarketing(ctx, f.actor, clientAID, "987654321012345678")
	if err != nil {
		t.Fatal("mixed pending Meta unavailable")
	}
	if _, err := service.SetupMarketing(ctx, f.actor, clientAID, meta.ID, meta.Revision, marketingSince, marketingUntil, []byte(marketingToken)); err != nil {
		t.Fatal("mixed Meta setup unavailable")
	}
	shop, err := service.CreateCommerce(ctx, f.actor, clientAID, "https://capacity-background.example.com")
	if err != nil {
		t.Fatal("mixed pending commerce unavailable")
	}
	key := commerceKey()
	defer clear(key)
	if _, err := service.SetupCommerce(ctx, f.actor, clientAID, shop.ID, shop.Revision, commerceStart, commerceEnd, "USD", key); err != nil {
		t.Fatal("mixed commerce setup unavailable")
	}
	property, err := service.Create(ctx, f.actor, clientAID, "987654321012345679")
	if err != nil {
		t.Fatal("mixed pending analytics unavailable")
	}
	googleKey := analyticsKey(t)
	defer clear(googleKey)
	if _, err := service.Setup(ctx, f.actor, clientAID, property.ID, property.Revision, marketingSince, marketingUntil, googleKey); err != nil {
		t.Fatal("mixed analytics setup unavailable")
	}
	for _, provider := range []string{"meta_ads", "woocommerce"} {
		err := audit.WithTransaction(correlation.New(f.base.ctx), f.runtime, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
			var id, client, state string
			var before, after int64
			if err := q.QueryRow(ctx, `SELECT job_id::text,client_id::text,state,before_revision,revision FROM app.provider_sync_claim($1)`, provider).Scan(&id, &client, &state, &before, &after); err != nil {
				return audit.Event{}, err
			}
			if state != "running" {
				return audit.Event{}, fmt.Errorf("synthetic claim not running")
			}
			yes := true
			return audit.Event{Actor: audit.Actor{Kind: audit.System}, Action: audit.Updated, ResourceKind: "analytics_sync", ResourceID: id, ClientID: client, Before: &audit.Snapshot{Exists: &yes, Revision: &before}, After: &audit.Snapshot{Exists: &yes, Revision: &after}, Metadata: audit.Metadata{Source: audit.Job}}, nil
		})
		if err != nil {
			t.Fatal("mixed audited claim unavailable")
		}
	}
	workerContext, stopWorkers := context.WithCancel(f.base.ctx)
	var background sync.WaitGroup
	var polls, workerFailures atomic.Int64
	defer func() { stopWorkers(); background.Wait() }()
	for i := 0; i < 2; i++ {
		u, _ := url.Parse(f.base.URL)
		cfg := f.runtime.Config().ConnConfig
		u.User = url.UserPassword(cfg.User, cfg.Password)
		settings := settings(t, u.String())
		settings.MaxConnections = 2
		pool, err := database.Open(f.base.ctx, settings)
		if err != nil {
			t.Fatal("mixed independent worker pool unavailable")
		}
		t.Cleanup(pool.Close)
		s, err := analytics.NewService(pool, ring)
		if err != nil {
			t.Fatal("mixed worker service unavailable")
		}
		worker, err := analytics.NewWorker(s)
		if err != nil {
			t.Fatal("mixed worker unavailable")
		}
		background.Add(1)
		go func() {
			defer background.Done()
			for workerContext.Err() == nil {
				didWork, err := worker.RunOnce(workerContext)
				if workerContext.Err() != nil {
					return
				}
				polls.Add(1)
				if didWork || err != nil {
					workerFailures.Add(1)
					return
				}
				select {
				case <-workerContext.Done():
					return
				case <-time.After(250 * time.Millisecond):
				}
			}
		}()
	}
	before := capacityState(t, f)
	var snapshotBefore string
	if f.admin.QueryRow(f.base.ctx, `SELECT md5(string_agg(id::text||workspace::text||revision::text,',' ORDER BY id)) FROM app.analytics_snapshots`).Scan(&snapshotBefore) != nil {
		t.Fatal("mixed snapshot baseline unavailable")
	}
	type result struct {
		route    string
		duration time.Duration
		ok       bool
		taskID   string
		clientID string
		actorID  string
	}
	results := make(chan result, 3000)
	start := make(chan struct{})
	var users sync.WaitGroup
	routes := append(append([]string{}, capacityRoutes...), "ga4", "woocommerce", "meta_ads")
	for user := 0; user < 100; user++ {
		users.Add(1)
		go func(user int) {
			defer users.Done()
			<-start
			for n := 0; n < 30; n++ {
				api := first
				if (user+n)%2 == 1 {
					api = second
				}
				id := ids[(user*30+n)%len(ids)]
				if user < 10 && n%10 == 0 {
					d, ok, task := capacityTaskWrite(api, client, sessions[user], id)
					results <- result{"task_create", d, ok, task, id, sessions[user].Session.User.ID}
					continue
				}
				route := routes[(user+n)%len(routes)]
				if route == "ga4" || route == "woocommerce" || route == "meta_ads" {
					d, ok := capacityReportRead(api, client, sessions[user], reports[id+route])
					results <- result{route, d, ok, "", "", ""}
				} else {
					d, ok := capacityRead(api, client, sessions[user], id, route)
					results <- result{route, d, ok, "", "", ""}
				}
			}
		}(user)
	}
	stamp := time.Now()
	close(start)
	users.Wait()
	close(results)
	elapsed := time.Since(stamp)
	stopWorkers()
	background.Wait()
	measurements := map[string][]time.Duration{}
	writes := []string{}
	writeBindings := map[string]result{}
	failures, count := 0, 0
	for r := range results {
		count++
		if !r.ok {
			failures++
		}
		measurements[r.route] = append(measurements[r.route], r.duration)
		if r.taskID != "" {
			writes = append(writes, r.taskID)
			writeBindings[r.taskID] = r
		}
	}
	t.Logf("mixed clients=500 stored_reports=1500 sessions=100 api_replicas=2 api_pool_each=10 worker_replicas=2 worker_pool_each=2 live_leases=2 queued=1 requests=%d invalid_or_timeout=%d writes=%d worker_polls=%d elapsed_ms=%.3f throughput_rps=%.2f", count, failures, len(writes), polls.Load(), float64(elapsed)/float64(time.Millisecond), float64(count)/elapsed.Seconds())
	if count != 3000 || failures != 0 || len(writes) != 30 || polls.Load() < 2 || workerFailures.Load() != 0 {
		t.Error("mixed requests/writes/global worker admission failed")
	}
	for route, values := range measurements {
		sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
		p := func(n int) time.Duration { return values[(len(values)*n+99)/100-1] }
		t.Logf("mixed route=%s n=%d p50_ms=%.3f p95_ms=%.3f p99_ms=%.3f max_ms=%.3f", route, len(values), float64(p(50))/float64(time.Millisecond), float64(p(95))/float64(time.Millisecond), float64(p(99))/float64(time.Millisecond), float64(values[len(values)-1])/float64(time.Millisecond))
		if p(95) > capacityBudget {
			t.Errorf("mixed P95 exceeds 2-second budget: %s", route)
		}
	}
	if len(measurements) != 11 {
		t.Error("mixed workload missed a route family")
	}
	after := capacityState(t, f)
	expected := append([]int64{}, before...)
	expected[2] += 30
	expected[3] += 30
	expected[12] += 30
	if !reflect.DeepEqual(after, expected) {
		t.Error("mixed writes changed unexpected domain/history/session counts")
	}
	var saved, audits int
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.tasks WHERE id=ANY($1::uuid[]) AND revision=1 AND status='backlog' AND title='Synthetic capacity mixed task'`, writes).Scan(&saved) != nil || saved != 30 {
		t.Error("mixed accepted task writes differ")
	}
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.audit_events WHERE resource_kind='task' AND resource_id=ANY($1::uuid[]) AND event_name='task.created'`, writes).Scan(&audits) != nil || audits != 30 {
		t.Error("mixed task audits differ")
	}
	if len(writeBindings) != 30 {
		t.Error("mixed write responses reused an ID")
	}
	for id, expected := range writeBindings {
		var bound bool
		if f.admin.QueryRow(f.base.ctx, `SELECT EXISTS(SELECT 1 FROM app.tasks t JOIN app.audit_events a ON a.resource_id=t.id AND a.resource_kind='task' AND a.event_name='task.created' WHERE t.id=$1::uuid AND t.client_id=$2::uuid AND t.created_by=$3::uuid AND a.client_id=t.client_id AND a.actor_user_id=t.created_by AND (a.after_state->>'revision')::bigint=t.revision)`, id, expected.clientID, expected.actorID).Scan(&bound) != nil || !bound {
			t.Error("mixed write/audit client and actor binding differ")
		}
	}
	var snapshotAfter string
	var running, queued, idle int
	if f.admin.QueryRow(f.base.ctx, `SELECT md5(string_agg(id::text||workspace::text||revision::text,',' ORDER BY id)) FROM app.analytics_snapshots`).Scan(&snapshotAfter) != nil || snapshotAfter != snapshotBefore {
		t.Error("mixed reads changed provider reports")
	}
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*) FILTER(WHERE state='running' AND lease_until>clock_timestamp()),count(*) FILTER(WHERE state='queued') FROM app.analytics_sync_jobs`).Scan(&running, &queued) != nil || running != 2 || queued != 1 {
		t.Error("mixed provider leases/admission changed")
	}
	if f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`).Scan(&idle) != nil || idle != 0 {
		t.Error("mixed background state held idle DB transactions")
	}
}

func seedCapacityReports(t *testing.T, f *administrationFixture, ids []string) map[string]capacityReport {
	t.Helper()
	records := []capacityReport{}
	reports := map[string]capacityReport{}
	for i, id := range ids {
		for p, provider := range []string{"ga4", "woocommerce", "meta_ads"} {
			connection := fmt.Sprintf("c5100000-0000-4000-8000-%012d", i*3+p+1)
			account := fmt.Sprintf("900000%06d", i+1)
			var w any
			switch provider {
			case "ga4":
				value := syntheticAnalyticsWorkspace(id, connection)
				if !ga4.ValidWorkspace(value, ga4.Request{ClientID: id, ConnectionID: connection, PropertyID: account, Since: marketingSince, Until: marketingUntil}) {
					t.Fatal("synthetic GA4 capacity report invalid")
				}
				w = value
			case "woocommerce":
				account = fmt.Sprintf("https://capacity-%d.example.com", i+1)
				value := syntheticCommerceWorkspace(t, connection)
				value.Orders.ClientID = id
				value.Products.ClientID = id
				value.Refunds.ClientID = id
				if !woocommerce.ValidWorkspace(value, woocommerce.Expectation{ClientID: id, ConnectionID: connection, Start: commerceStart, End: commerceEnd, Currency: "USD", PerPage: 100}) {
					t.Fatal("synthetic commerce capacity report invalid")
				}
				w = value
			case "meta_ads":
				value := syntheticMarketingWorkspace(t, connection)
				value.Report.ClientID = id
				if !metaads.ValidWorkspace(value, metaads.Request{ClientID: id, ConnectionID: connection, AccountID: account, Since: marketingSince, Until: marketingUntil}) {
					t.Fatal("synthetic Meta capacity report invalid")
				}
				w = value
			}
			raw, err := json.Marshal(w)
			if err != nil {
				t.Fatal("capacity report encoding failed")
			}
			r := capacityReport{id, connection, provider, account, raw}
			records = append(records, r)
			reports[id+provider] = r
		}
	}
	raw, err := json.Marshal(records)
	if err != nil {
		t.Fatal("capacity reports encoding failed")
	}
	tx, err := f.admin.Begin(f.base.ctx)
	if err != nil {
		t.Fatal("capacity report seed unavailable")
	}
	defer tx.Rollback(f.base.ctx)
	if _, err := tx.Exec(f.base.ctx, `CREATE TEMP TABLE capacity_reports ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("Client" uuid,"Connection" uuid,"Provider" text,"Account" text,"Workspace" jsonb)`, raw); err != nil {
		t.Fatal("capacity report seed shape failed")
	}
	steps := []string{
		`INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id,state) SELECT "Connection","Client","Provider","Account",'connected' FROM capacity_reports`,
		`INSERT INTO app.analytics_sync_jobs(id,client_id,connection_id,requested_by,provider,since,until,start_at,end_at,currency,connection_revision,generation,credential_revision,state,finished_at)
 SELECT gen_random_uuid(),"Client","Connection",$1::uuid,"Provider",CASE WHEN "Provider"<>'woocommerce' THEN DATE '2026-10-01' END,CASE WHEN "Provider"<>'woocommerce' THEN DATE '2026-10-03' END,
 CASE WHEN "Provider"='woocommerce' THEN TIMESTAMPTZ '2026-10-01 00:00:00+00' END,CASE WHEN "Provider"='woocommerce' THEN TIMESTAMPTZ '2026-10-02 00:00:00+00' END,CASE WHEN "Provider"='woocommerce' THEN 'USD' END,1,1,1,'succeeded',clock_timestamp() FROM capacity_reports`,
		`INSERT INTO app.analytics_snapshots(client_id,connection_id,provider,generation,since,until,start_at,end_at,currency,workspace)
 SELECT "Client","Connection","Provider",1,CASE WHEN "Provider"<>'woocommerce' THEN DATE '2026-10-01' END,CASE WHEN "Provider"<>'woocommerce' THEN DATE '2026-10-03' END,
 CASE WHEN "Provider"='woocommerce' THEN TIMESTAMPTZ '2026-10-01 00:00:00+00' END,CASE WHEN "Provider"='woocommerce' THEN TIMESTAMPTZ '2026-10-02 00:00:00+00' END,CASE WHEN "Provider"='woocommerce' THEN 'USD' END,"Workspace" FROM capacity_reports`,
	}
	for i, sql := range steps {
		var args []any
		if i == 1 {
			args = []any{f.actor}
		}
		if _, err := tx.Exec(f.base.ctx, sql, args...); err != nil {
			t.Fatalf("capacity report seed failed at stage %d", i+1)
		}
	}
	if tx.Commit(f.base.ctx) != nil {
		t.Fatal("capacity report seed commit failed")
	}
	for _, table := range []string{"integration_connections", "analytics_sync_jobs", "analytics_snapshots"} {
		if _, err := f.admin.Exec(f.base.ctx, "ANALYZE app."+table); err != nil {
			t.Fatal("capacity provider statistics failed")
		}
	}
	return reports
}

func capacityReportRead(api *compiledAPI, client *http.Client, session identity.LoginResult, r capacityReport) (time.Duration, bool) {
	module, query := "analytics", "since="+marketingSince+"&until="+marketingUntil
	if r.Provider == "meta_ads" {
		module = "marketing"
	}
	if r.Provider == "woocommerce" {
		module = "commerce"
		query = "start=" + commerceStart + "&end=" + commerceEnd + "&currency=USD"
	}
	request, err := http.NewRequestWithContext(api.Context, http.MethodGet, api.Origin+"/api/v1/clients/"+r.Client+"/"+module+"/"+r.Connection+"?"+query, nil)
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
		return duration, false
	}
	var view struct {
		Status analytics.Status `json:"status"`
		Data   json.RawMessage  `json:"data"`
	}
	if json.Unmarshal(body, &view) != nil || view.Status.State != "succeeded" || view.Status.Stale || view.Status.JobID == nil || view.Status.SyncedAt == nil {
		return duration, false
	}
	var actual, expected any
	return duration, json.Unmarshal(view.Data, &actual) == nil && json.Unmarshal(r.Workspace, &expected) == nil && reflect.DeepEqual(actual, expected)
}

// Observe real planner choices without forcing index scans or printing private
// statements/arguments. Existing index-eligibility tests cover the contracts;
// these plans cover the larger measured fixture's bounded retrieval primitives.
func capacityPlans(t *testing.T, f *administrationFixture, clientID, connectionID string) {
	t.Helper()
	queries := []struct {
		name, sql string
		args      []any
		rows      int
	}{
		{"task_page", `SELECT id FROM app.tasks WHERE client_id=$1::uuid AND archived_at IS NULL ORDER BY id LIMIT 25`, []any{clientID}, 25},
		{"overview_due_tasks", `SELECT id FROM app.tasks WHERE client_id=$1::uuid AND archived_at IS NULL AND status NOT IN ('done','cancelled') AND due_at IS NOT NULL AND due_at<statement_timestamp() ORDER BY due_at,id LIMIT 6`, []any{clientID}, 6},
		{"overview_due_reminders", `SELECT id FROM app.reminders WHERE client_id=$1::uuid AND status='pending' AND scheduled_at<statement_timestamp() ORDER BY scheduled_at,id LIMIT 6`, []any{clientID}, 6},
		{"provider_snapshot", `SELECT workspace FROM app.analytics_snapshots WHERE client_id=$1::uuid AND connection_id=$2::uuid AND generation=1 AND provider='meta_ads' AND since=DATE '2026-10-01' AND until=DATE '2026-10-03'`, []any{clientID, connectionID}, 1},
	}
	for _, query := range queries {
		var raw []byte
		if f.admin.QueryRow(f.base.ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+query.sql, query.args...).Scan(&raw) != nil {
			t.Fatal("capacity measured query plan unavailable")
		}
		var result []map[string]any
		if json.Unmarshal(raw, &result) != nil || len(result) != 1 {
			t.Fatal("capacity query plan shape invalid")
		}
		plan, ok := result[0]["Plan"].(map[string]any)
		if !ok {
			t.Fatal("capacity query plan absent")
		}
		rows, ok := plan["Actual Rows"].(float64)
		if !ok || int(rows) != query.rows {
			t.Error("capacity query plan returned unexpected rows")
		}
		indexes := []string{}
		var walk func(map[string]any)
		walk = func(node map[string]any) {
			if name, ok := node["Index Name"].(string); ok {
				indexes = append(indexes, name)
			}
			if children, ok := node["Plans"].([]any); ok {
				for _, child := range children {
					if child, ok := child.(map[string]any); ok {
						walk(child)
					}
				}
			}
		}
		walk(plan)
		if len(indexes) == 0 {
			t.Error("capacity measured partition retrieval has no index path")
		}
		t.Logf("query_plan family=%s rows=%v indexes=%v shared_hit_blocks=%v shared_read_blocks=%v planning_ms=%v execution_ms=%v", query.name, rows, indexes, plan["Shared Hit Blocks"], plan["Shared Read Blocks"], result[0]["Planning Time"], result[0]["Execution Time"])
	}
}

func capacityTaskWrite(api *compiledAPI, client *http.Client, session identity.LoginResult, id string) (time.Duration, bool, string) {
	body := []byte(`{"title":"Synthetic capacity mixed task","description":"Synthetic mixed capacity fixture","status":"backlog","priority":"medium","assignee_id":null,"start_at":null,"due_at":null,"tags":[]}`)
	request, err := http.NewRequestWithContext(api.Context, http.MethodPost, api.Origin+"/api/v1/clients/"+id+"/tasks", bytes.NewReader(body))
	if err != nil {
		return 0, false, ""
	}
	request.Header.Set("Origin", api.Origin)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", session.CSRF)
	request.AddCookie(&http.Cookie{Name: "else_session", Value: session.Token})
	request.AddCookie(&http.Cookie{Name: "else_csrf", Value: session.CSRF})
	stamp := time.Now()
	response, err := client.Do(request)
	if err != nil {
		return time.Since(stamp), false, ""
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	duration := time.Since(stamp)
	var value struct {
		Data tasks.Mutation `json:"data"`
	}
	if err != nil || len(raw) > 65536 || response.StatusCode != 201 || response.Header.Get("Cache-Control") != "no-store" || json.Unmarshal(raw, &value) != nil {
		return duration, false, ""
	}
	v := value.Data
	ok := v.ID != "" && v.Revision == 1
	return duration, ok, v.ID
}
