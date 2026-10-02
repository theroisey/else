//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/overview"
)

func TestOverviewHTTPReadOnlyAuthAndStrictBoundedRequestContract(t *testing.T) {
	f := newOverviewFixture(t)
	path := overviewPath(clientAID)
	assertStatus(t, f.request(t, nil, "GET", path, nil, nil), 401, "authentication_required")
	for _, method := range []string{"POST", "PUT", "DELETE", "PATCH", "HEAD"} {
		w := f.request(t, &f.login, method, path, map[string]any{"amount_minor": "1"}, nil)
		if method == "HEAD" {
			assertStatus(t, w, 405, "")
		} else {
			assertStatus(t, w, 405, "method_not_allowed")
		}
		if w.Header().Get("Allow") != "GET" {
			t.Fatal("method scope changed")
		}
	}
	for _, suffix := range []string{"/extra", "/", "?", "?limit=999", "?cursor=forged", "?as_of=2020-01-01", "?x=" + strings.Repeat("x", 2048)} {
		assertStatus(t, f.request(t, &f.login, "GET", path+suffix, nil, nil), 400, "invalid_request")
	}
	assertStatus(t, f.request(t, &f.login, "GET", "clients/not-a-uuid/overview", nil, nil), 400, "invalid_request")
	w := f.request(t, &f.login, "GET", path, nil, nil)
	assertStatus(t, w, 200, "")
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private overview cacheable")
	}
	var response struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &response); e != nil || len(response.Data) != 7 {
		t.Fatal("overview envelope changed", e)
	}
	var client map[string]json.RawMessage
	if e := json.Unmarshal(response.Data["client"], &client); e != nil || len(client) != 4 {
		t.Fatal("client profile expanded", e)
	}
	f.retainAdministrator(t)
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, f.actor); e != nil {
		t.Fatal(e)
	}
	assertStatus(t, f.request(t, &f.login, "GET", path, nil, nil), 401, "authentication_required")
	if _, e := f.overview.Read(f.base.ctx, f.actor, clientAID); !errors.Is(e, overview.ErrMissing) {
		t.Fatal("disabled actor read modules", e)
	}
}

func TestOverviewExactNowAndSevenDayBoundaries(t *testing.T) {
	f := newOverviewFixture(t)
	// One DO command fixes statement_timestamp for both source fixtures and read.
	sql := fmt.Sprintf(`DO $$ DECLARE stamp timestamptz:=statement_timestamp(); v jsonb; BEGIN
  INSERT INTO app.tasks(id,client_id,created_by,title,status,priority,due_at)
   SELECT gen_random_uuid(),'%s','%s','Boundary task '||i,'todo','medium',stamp+offset_value
   FROM (VALUES(1,INTERVAL '0 seconds'),(2,INTERVAL '-1 microsecond'),(3,INTERVAL '7 days'),(4,INTERVAL '7 days 1 microsecond')) x(i,offset_value);
  INSERT INTO app.reminders(id,client_id,created_by,owner_id,title,status,scheduled_at,scheduled_local,timezone,utc_offset_seconds)
   SELECT gen_random_uuid(),'%s','%s','%s','Boundary reminder '||i,'pending',stamp+offset_value,
   to_char((stamp+offset_value) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),'UTC',0
   FROM (VALUES(1,INTERVAL '0 seconds'),(2,INTERVAL '-1 microsecond'),(3,INTERVAL '7 days'),(4,INTERVAL '7 days 1 microsecond')) x(i,offset_value);
  v:=app.client_overview('%s','%s');
  IF jsonb_array_length(v->'tasks'->'overdue'->'items')<>2 OR
    jsonb_array_length(v->'tasks'->'due_soon'->'items')<>1 OR
    jsonb_array_length(v->'reminders'->'due'->'items')<>2 OR
    jsonb_array_length(v->'reminders'->'upcoming'->'items')<>1 OR
    v->'tasks'->'due_soon'->'items'->0->>'title'<>'Boundary task 3' OR
    v->'reminders'->'upcoming'->'items'->0->>'title'<>'Boundary reminder 3' THEN
   RAISE EXCEPTION 'Overview instant boundary changed'; END IF;
 END $$`, clientAID, f.actor, clientAID, f.actor, f.actor, f.actor, clientAID)
	if _, e := f.admin.Exec(f.base.ctx, sql); e != nil {
		t.Fatal(e)
	}
}

func TestOverviewRuntimeAndPopulatedMigrationRoundTripPreserveHistory(t *testing.T) {
	f := newOverviewFixture(t)
	ctx := correlation.New(f.base.ctx)
	f.seedAttention(t)
	f.createCollection(t, billingProfile())
	f.createPricing(t, pricingProfile())
	var before string
	fingerprint := `SELECT md5((SELECT string_agg(row_to_json(x)::text,'' ORDER BY id) FROM app.tasks x)||
  (SELECT string_agg(row_to_json(x)::text,'' ORDER BY id) FROM app.reminders x)||
  (SELECT string_agg(row_to_json(x)::text,'' ORDER BY id) FROM app.collections x)||
  (SELECT string_agg(row_to_json(x)::text,'' ORDER BY id) FROM app.pricing_versions x)||
  (SELECT string_agg(row_to_json(x)::text,'' ORDER BY id) FROM app.audit_events x))`
	if e := f.admin.QueryRow(ctx, fingerprint).Scan(&before); e != nil {
		t.Fatal(e)
	}
	role, url := f.base.role(t)
	quoted := pgx.Identifier{role}.Sanitize()
	if _, e := f.admin.Exec(ctx, `GRANT USAGE ON SCHEMA app TO `+quoted); e != nil {
		t.Fatal(e)
	}
	p, e := pgxpool.New(ctx, url)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(p.Close)
	if _, e = p.Exec(ctx, `SELECT app.client_overview($1::uuid,$2::uuid)`, f.actor, clientAID); e == nil {
		t.Fatal("PUBLIC overview execution allowed")
	}
	if _, e = f.admin.Exec(ctx, `GRANT EXECUTE ON FUNCTION app.client_overview(uuid,uuid) TO `+quoted); e != nil {
		t.Fatal(e)
	}
	s, e := overview.NewService(p)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Read(ctx, f.actor, clientAID); e != nil {
		t.Fatal("single EXECUTE grant cannot compose guarded readers", e)
	}
	for _, sql := range []string{`SELECT * FROM app.tasks`, `SELECT * FROM app.collections`, `SELECT * FROM app.reminders`, `SELECT * FROM app.audit_events`, `SELECT app.billing_document(gen_random_uuid())`, `SELECT app.pricing_version_document(gen_random_uuid(),true)`} {
		if _, e = p.Exec(ctx, sql); e == nil {
			t.Fatal("overview role gained table/private projector access", sql)
		}
	}
	var secure bool
	if e = f.admin.QueryRow(ctx, `SELECT prosecdef AND provolatile='v' AND lower(array_to_string(proconfig,',')) LIKE '%search_path=pg_catalog%' AND lower(array_to_string(proconfig,',')) LIKE '%timezone=utc%' FROM pg_proc WHERE oid='app.client_overview(uuid,uuid)'::regprocedure`).Scan(&secure); e != nil || !secure {
		t.Fatal("definer configuration unsafe", e)
	}
	migration := provider(t, f.base)
	if _, e = migration.DownTo(ctx, 13); e != nil {
		t.Fatal("populated overview down failed", e)
	}
	var after string
	if e = f.admin.QueryRow(ctx, fingerprint).Scan(&after); e != nil || before != after {
		t.Fatal("read-only down changed history", e)
	}
	if _, e = migration.Up(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Read(ctx, f.actor, clientAID); e == nil {
		t.Fatal("recreated overview inherited runtime grant")
	}
	if _, e = f.admin.Exec(ctx, `GRANT EXECUTE ON FUNCTION app.client_overview(uuid,uuid) TO `+quoted); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Read(ctx, f.actor, clientAID); e != nil {
		t.Fatal(e)
	}
	if e = f.admin.QueryRow(ctx, fingerprint).Scan(&after); e != nil || before != after {
		t.Fatal("overview up changed history", e)
	}
	var keys int
	if e = f.admin.QueryRow(ctx, `SELECT count(*) FROM app.permissions`).Scan(&keys); e != nil || keys != 33 {
		t.Fatal("overview expanded permission catalog", e)
	}
	tx, e := f.admin.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SET LOCAL enable_seqscan=off`); e != nil {
		t.Fatal(e)
	}
	for _, spec := range []struct{ query, index string }{
		{`EXPLAIN SELECT id FROM app.tasks WHERE client_id=$1::uuid AND archived_at IS NULL AND status NOT IN ('done','cancelled') AND due_at IS NOT NULL AND due_at>statement_timestamp() AND due_at<=statement_timestamp()+INTERVAL '7 days' ORDER BY due_at,id LIMIT 6`, "tasks_open_due"},
		{`EXPLAIN SELECT id FROM app.reminders WHERE client_id=$1::uuid AND status='pending' AND scheduled_at>statement_timestamp() AND scheduled_at<=statement_timestamp()+INTERVAL '7 days' ORDER BY scheduled_at,id LIMIT 6`, "reminders_pending_due"},
	} {
		rows, e := tx.Query(ctx, spec.query, clientAID)
		if e != nil {
			t.Fatal(e)
		}
		var plan strings.Builder
		for rows.Next() {
			var line string
			if e = rows.Scan(&line); e != nil {
				t.Fatal(e)
			}
			plan.WriteString(line)
		}
		rows.Close()
		if e = rows.Err(); e != nil || !strings.Contains(plan.String(), spec.index) || !strings.Contains(plan.String(), "Limit") {
			t.Fatal("deadline index cannot support bounded queue", plan.String(), e)
		}
	}
}

func TestOverviewQueuedReadObservesRevocationDisableAndCommittedLifecycle(t *testing.T) {
	for _, scenario := range []string{"client grant revoked", "module grant revoked", "disabled", "archived", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			f := newOverviewFixture(t)
			f.seedAttention(t)
			m := f.createCollection(t, billingProfile())
			actor, assignment := f.grantPlanning(t, []authorization.Permission{authorization.ClientsView, authorization.BillingView, authorization.TasksView})
			ctx, cancel := context.WithTimeout(f.base.ctx, 8*time.Second)
			defer cancel()
			tx, e := f.admin.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback(ctx)
			if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); e != nil {
				t.Fatal(e)
			}
			switch scenario {
			case "client grant revoked":
				_, e = tx.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, assignment)
			case "module grant revoked":
				_, e = tx.Exec(ctx, `UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id=(SELECT role_id FROM app.user_roles WHERE id=$1::uuid) AND permission_key='billing.view'`, assignment)
			case "disabled":
				_, e = tx.Exec(ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, actor)
			case "archived":
				_, e = tx.Exec(ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID)
			case "cancelled":
				_, e = tx.Exec(ctx, `UPDATE app.collections SET cancelled_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, m.ID)
			}
			if e != nil {
				t.Fatal(e)
			}
			type answer struct {
				v overview.Overview
				e error
			}
			result := make(chan answer, 1)
			go func() { v, e := f.overview.Read(ctx, actor, clientAID); result <- answer{v, e} }()
			deadline := time.Now().Add(3 * time.Second)
			for {
				var waiting bool
				if e = f.adminPool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory')`).Scan(&waiting); e != nil {
					t.Fatal(e)
				}
				if waiting {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("overview did not wait on lifecycle lock")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if e = tx.Commit(ctx); e != nil {
				t.Fatal(e)
			}
			a := <-result
			if scenario == "client grant revoked" || scenario == "disabled" {
				if !errors.Is(a.e, overview.ErrMissing) {
					t.Fatal("queued read used stale access", a.e)
				}
				return
			}
			if a.e != nil {
				t.Fatal(a.e)
			}
			switch scenario {
			case "module grant revoked":
				if a.v.Finance != nil || a.v.Tasks == nil {
					t.Fatal("revoked module leaked")
				}
			case "archived":
				if a.v.Client.Status != "archived" || a.v.Client.ArchivedAt == nil {
					t.Fatal("stale client lifecycle")
				}
			case "cancelled":
				if a.v.Finance.Currencies[0].OutstandingMinor != "0" || a.v.Finance.Currencies[0].CancelledAmountMinor != "100" {
					t.Fatal("finance read before committed cancellation")
				}
			}
		})
	}
}
