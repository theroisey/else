//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/integrations/connections"
)

type connectionFixture struct {
	*clientFixture
	connections *connections.Service
}

func newConnectionFixture(t *testing.T) *connectionFixture {
	t.Helper()
	f := newClientFixture(t)
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION app.integration_connection_list(uuid,uuid,uuid,integer),app.integration_connection_read(uuid,uuid,uuid) TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	s, e := connections.NewService(f.runtime)
	if e != nil {
		t.Fatal(e)
	}
	logger := slog.New(slog.NewJSONHandler(f.logs, nil))
	auth, e := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if e != nil {
		t.Fatal(e)
	}
	h, e := connections.NewHandler(s, auth, logger)
	if e != nil {
		t.Fatal(e)
	}
	f.handler = httpapi.RequestMiddleware(logger, h)
	return &connectionFixture{f, s}
}
func connectionID(n int) string { return fmt.Sprintf("e3000000-0000-4000-8000-%012d", n) }
func (f *connectionFixture) seed(t *testing.T, client string, first, count int) {
	t.Helper()
	if _, e := f.admin.Exec(f.base.ctx, `INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id,revision)
 SELECT ('e3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1::uuid,'meta_ads',(990000+n)::text,9223372036854775807 FROM generate_series($2::int,$3::int) n`, client, first, first+count-1); e != nil {
		t.Fatal(e)
	}
}
func (f *connectionFixture) grant(t *testing.T, permissions []authorization.Permission, client string) (string, string) {
	t.Helper()
	ctx := correlation.New(f.base.ctx)
	user := f.user(t, "metadata@example.com")
	role, e := f.accounts.CreateRole(ctx, f.actor, "Metadata reader", permissions)
	if e != nil {
		t.Fatal(e)
	}
	assignment, e := f.authorizer.AssignRole(ctx, f.actor, user.ID, role.ID, authorization.Client, client)
	if e != nil {
		t.Fatal(e)
	}
	return user.ID, assignment
}
func metadataPath(client string) string { return "clients/" + client + "/integrations" }

func TestIntegrationMetadataHTTPPagingSafeFieldsAndNoReadAudit(t *testing.T) {
	f := newConnectionFixture(t)
	path := metadataPath(clientAID)
	w := f.request(t, &f.login, "GET", path, nil, nil)
	assertStatus(t, w, 200, "")
	var page connections.Page
	if e := json.Unmarshal(w.Body.Bytes(), &page); e != nil || page.Data == nil || len(page.Data) != 0 || page.Page.NextCursor != nil {
		t.Fatal("empty metadata fabricated", e)
	}
	f.seed(t, clientAID, 1, 105)
	f.seed(t, clientBID, 106, 1)
	var before, after int
	if e := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.audit_events`).Scan(&before); e != nil {
		t.Fatal(e)
	}
	cursor := ""
	seen := 0
	for {
		w = f.request(t, &f.login, "GET", path+"?limit=100"+cursor, nil, nil)
		assertStatus(t, w, 200, "")
		if e := json.Unmarshal(w.Body.Bytes(), &page); e != nil {
			t.Fatal(e)
		}
		if len(page.Data) > 100 {
			t.Fatal("unbounded metadata")
		}
		for _, c := range page.Data {
			seen++
			if c.ID != connectionID(seen) || c.ClientID != clientAID || c.Revision != "9223372036854775807" || c.State != "pending" {
				t.Fatal("metadata precision or client boundary")
			}
		}
		if page.Page.NextCursor == nil {
			break
		}
		cursor = "&cursor=" + *page.Page.NextCursor
		assertStatus(t, f.request(t, &f.login, "GET", metadataPath(clientBID)+"?cursor="+*page.Page.NextCursor, nil, nil), 400, "invalid_request")
	}
	if seen != 105 {
		t.Fatal("paging omitted or duplicated metadata", seen)
	}
	w = f.request(t, &f.login, "GET", path+"/"+connectionID(1), nil, nil)
	assertStatus(t, w, 200, "")
	var detail struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &detail); e != nil || len(detail.Data) != 7 {
		t.Fatal("metadata projection expanded", e)
	}
	for _, key := range []string{"id", "client_id", "provider", "state", "revision", "created_at", "updated_at"} {
		if detail.Data[key] == nil {
			t.Fatal("missing safe field", key)
		}
	}
	for _, state := range []string{"pending", "connected", "disconnect_pending", "revocation_failed", "disconnected", "reauthorization_required"} {
		if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET state=$2 WHERE id=$1::uuid`, connectionID(1), state); e != nil {
			t.Fatal(e)
		}
		if c, e := f.connections.Detail(f.base.ctx, f.actor, clientAID, connectionID(1)); e != nil || c.State != state {
			t.Fatal("stored lifecycle fact changed", e)
		}
	}
	assertStatus(t, f.request(t, &f.login, "GET", path+"/"+connectionID(106), nil, nil), 404, "not_found")
	assertStatus(t, f.request(t, &f.login, "GET", path+"/"+connectionID(999), nil, nil), 404, "not_found")
	assertStatus(t, f.request(t, &f.login, "GET", metadataPath(connectionID(999)), nil, nil), 404, "not_found")
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID); e != nil {
		t.Fatal(e)
	}
	assertStatus(t, f.request(t, &f.login, "GET", path, nil, nil), 200, "")
	if e := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.audit_events`).Scan(&after); e != nil || before != after {
		t.Fatal("read wrote audit", e)
	}
	if strings.Contains(w.Body.String(), "990001") || strings.Contains(f.logs.String(), "990001") || strings.Contains(f.logs.String(), f.login.Token) {
		t.Fatal("private account or session leaked")
	}
}

func TestIntegrationMetadataHTTPReadOnlyAndValidation(t *testing.T) {
	f := newConnectionFixture(t)
	path := metadataPath(clientAID)
	assertStatus(t, f.request(t, nil, "GET", path, nil, nil), 401, "authentication_required")
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD"} {
		w := f.request(t, &f.login, method, path, nil, nil)
		code := "method_not_allowed"
		if method == "HEAD" {
			code = ""
		}
		assertStatus(t, w, 405, code)
		if w.Header().Get("Allow") != "GET" {
			t.Fatal("write advertised")
		}
	}
	for _, suffix := range []string{"/", "/bad", "/" + connectionID(1) + "/extra", "?", "?limit=0", "?limit=101", "?limit=1&limit=2", "?cursor=forged", "?unknown=1", "/" + connectionID(1) + "?limit=1"} {
		assertStatus(t, f.request(t, &f.login, "GET", path+suffix, nil, nil), 400, "invalid_request")
	}
	assertStatus(t, f.request(t, &f.login, "GET", metadataPath("bad"), nil, nil), 400, "invalid_request")
}

func TestIntegrationMetadataIndependentClientGrants(t *testing.T) {
	for _, permissions := range [][]authorization.Permission{{authorization.ClientsView}, {authorization.IntegrationsView}, {authorization.ClientsView, authorization.IntegrationsManage, authorization.AnalyticsView}, {authorization.ClientsView, authorization.IntegrationsView}} {
		t.Run(fmt.Sprint(permissions), func(t *testing.T) {
			f := newConnectionFixture(t)
			f.seed(t, clientAID, 1, 1)
			f.seed(t, clientBID, 2, 1)
			actor, _ := f.grant(t, permissions, clientAID)
			_, e := f.connections.List(f.base.ctx, actor, clientAID, connections.Filter{Limit: 25})
			_, d := f.connections.Detail(f.base.ctx, actor, clientAID, connectionID(1))
			if len(permissions) == 2 && permissions[1] == authorization.IntegrationsView {
				if e != nil || d != nil {
					t.Fatal("explicit view denied", e, d)
				}
				login, e := f.service.Login(correlation.New(f.base.ctx), "metadata@example.com", bootstrapPassword)
				if e != nil {
					t.Fatal(e)
				}
				assertStatus(t, f.request(t, &login, "GET", metadataPath(clientAID), nil, nil), 200, "")
				if _, e = f.admin.Exec(f.base.ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, actor); e != nil {
					t.Fatal(e)
				}
				assertStatus(t, f.request(t, &login, "GET", metadataPath(clientAID), nil, nil), 401, "authentication_required")
			} else if !errors.Is(e, connections.ErrMissing) || !errors.Is(d, connections.ErrMissing) {
				t.Fatal("implicit view allowed", e, d)
			}
			if _, e = f.connections.List(f.base.ctx, actor, clientBID, connections.Filter{Limit: 25}); !errors.Is(e, connections.ErrMissing) {
				t.Fatal("foreign client visible", e)
			}
			if _, e = f.connections.Detail(f.base.ctx, actor, clientAID, connectionID(2)); !errors.Is(e, connections.ErrMissing) {
				t.Fatal("foreign connection visible", e)
			}
		})
	}
}

func TestIntegrationMetadataQueuedReadsRecheckRevocationAndDisablement(t *testing.T) {
	for _, kind := range []string{"list", "detail"} {
		for _, scenario := range []string{"assignment", "client view", "integration view", "disabled"} {
			t.Run(kind+"/"+scenario, func(t *testing.T) {
				f := newConnectionFixture(t)
				f.seed(t, clientAID, 1, 1)
				actor, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsView}, clientAID)
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
				case "assignment":
					_, e = tx.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, assignment)
				case "disabled":
					_, e = tx.Exec(ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, actor)
				default:
					key := "clients.view"
					if scenario == "integration view" {
						key = "integrations.view"
					}
					_, e = tx.Exec(ctx, `UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id=(SELECT role_id FROM app.user_roles WHERE id=$1::uuid) AND permission_key=$2`, assignment, key)
				}
				if e != nil {
					t.Fatal(e)
				}
				result := make(chan error, 1)
				go func() {
					if kind == "list" {
						p, e := f.connections.List(ctx, actor, clientAID, connections.Filter{Limit: 25})
						if len(p.Data) != 0 {
							result <- fmt.Errorf("partial data leaked")
							return
						}
						result <- e
					} else {
						c, e := f.connections.Detail(ctx, actor, clientAID, connectionID(1))
						if c.ID != "" {
							result <- fmt.Errorf("detail leaked")
							return
						}
						result <- e
					}
				}()
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
						t.Fatal("read did not wait for lifecycle writer")
					}
					time.Sleep(10 * time.Millisecond)
				}
				if e = tx.Commit(ctx); e != nil {
					t.Fatal(e)
				}
				if e = <-result; !errors.Is(e, connections.ErrMissing) {
					t.Fatal("stale authorization used", e)
				}
			})
		}
	}
}

func TestIntegrationMetadataStoragePrivilegesConstraintsAndRollback(t *testing.T) {
	f := newConnectionFixture(t)
	f.seed(t, clientAID, 1, 1)
	var seeded int
	if e := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.role_permissions WHERE permission_key='integrations.view' AND seeded AND revoked_at IS NULL AND role_id='00000000-0000-4000-8000-000000000001'`).Scan(&seeded); e != nil || seeded != 1 {
		t.Fatal("explicit view seed missing", e)
	}
	var other int
	if e := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.role_permissions WHERE permission_key='integrations.view' AND role_id<>'00000000-0000-4000-8000-000000000001'`).Scan(&other); e != nil || other != 0 {
		t.Fatal("existing role gained view", e)
	}
	for _, sql := range []string{`SELECT * FROM app.integration_connections`, `UPDATE app.integration_connections SET state='connected'`, `DELETE FROM app.integration_connections`, `TRUNCATE app.integration_connections`, `INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES(gen_random_uuid(),gen_random_uuid(),'meta_ads','1')`, `SELECT app.integration_connection_ownership_guard()`} {
		if _, e := f.runtime.Exec(f.base.ctx, sql); e == nil {
			t.Fatal("runtime accessed private storage", sql)
		}
	}
	var helper, tableAccess bool
	if e := f.runtime.QueryRow(f.base.ctx, `SELECT has_function_privilege(current_user,'app.integration_connection_ownership_guard()','EXECUTE'),has_table_privilege(current_user,'app.integration_connections','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`).Scan(&helper, &tableAccess); e != nil || helper || tableAccess {
		t.Fatal("runtime helper/table privileges expanded", e)
	}
	role, url := f.base.role(t)
	if _, e := f.admin.Exec(f.base.ctx, `GRANT USAGE ON SCHEMA app TO `+pgx.Identifier{role}.Sanitize()); e != nil {
		t.Fatal(e)
	}
	p, e := pgxpool.New(f.base.ctx, url)
	if e != nil {
		t.Fatal(e)
	}
	defer p.Close()
	for _, fn := range []string{"app.integration_connection_read(uuid,uuid,uuid)", "app.integration_connection_list(uuid,uuid,uuid,integer)", "app.integration_connection_ownership_guard()"} {
		var allowed bool
		if e := p.QueryRow(f.base.ctx, `SELECT has_function_privilege(current_user,$1,'EXECUTE')`, fn).Scan(&allowed); e != nil || allowed {
			t.Fatal("PUBLIC function privilege expanded", e)
		}
	}
	for _, sql := range []string{`SELECT app.integration_connection_read($1::uuid,$2::uuid,$3::uuid)`, `SELECT app.integration_connection_list($1::uuid,$2::uuid,$3::uuid,25)`} {
		if _, e = p.Exec(f.base.ctx, sql, f.actor, clientAID, connectionID(1)); e == nil {
			t.Fatal("PUBLIC read allowed")
		}
	}
	for _, fn := range []string{"app.integration_connection_read(uuid,uuid,uuid)", "app.integration_connection_list(uuid,uuid,uuid,integer)"} {
		var secure bool
		if e = f.admin.QueryRow(f.base.ctx, `SELECT prosecdef AND provolatile='v' AND lower(array_to_string(proconfig,',')) LIKE '%search_path=pg_catalog%' AND lower(array_to_string(proconfig,',')) LIKE '%timezone=utc%' FROM pg_proc WHERE oid=$1::regprocedure`, fn).Scan(&secure); e != nil || !secure {
			t.Fatal("unsafe definer", e)
		}
	}
	for _, set := range []string{"id=gen_random_uuid()", "client_id='" + clientBID + "'", "provider='other'", "provider_account_id='2'", "created_at=created_at-INTERVAL '1 second'", "state='success'", "revision=0", "generation=0", "updated_at='infinity'", "updated_at=created_at-INTERVAL '1 second'"} {
		if _, e = f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET `+set+` WHERE id=$1::uuid`, connectionID(1)); e == nil {
			t.Fatal("invalid metadata update allowed", set)
		}
	}
	for _, account := range []string{"", "0", "01", "act_123", strings.Repeat("1", 33), "990001"} {
		if _, e = f.admin.Exec(f.base.ctx, `INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES(gen_random_uuid(),$1::uuid,'meta_ads',$2)`, clientBID, account); e == nil {
			t.Fatal("invalid or reassigned account accepted")
		}
	}
	for _, values := range []string{
		"'00000000-0000-0000-0000-000000000000','meta_ads','pending',1,1,clock_timestamp(),clock_timestamp()",
		"gen_random_uuid(),'other','pending',1,1,clock_timestamp(),clock_timestamp()",
		"gen_random_uuid(),'meta_ads','success',1,1,clock_timestamp(),clock_timestamp()",
		"gen_random_uuid(),'meta_ads','pending',0,1,clock_timestamp(),clock_timestamp()",
		"gen_random_uuid(),'meta_ads','pending',1,0,clock_timestamp(),clock_timestamp()",
		"gen_random_uuid(),'meta_ads','pending',1,1,'-infinity',clock_timestamp()",
		"gen_random_uuid(),'meta_ads','pending',1,1,clock_timestamp(),'infinity'",
	} {
		if _, e := f.admin.Exec(f.base.ctx, `INSERT INTO app.integration_connections(id,provider,state,revision,generation,created_at,updated_at,client_id,provider_account_id) SELECT `+values+`,$1::uuid,'999999'`, clientAID); e == nil {
			t.Fatal("invalid insert passed constraints")
		}
	}
	migration := provider(t, f.base)
	if _, e = migration.Down(f.base.ctx); e == nil {
		t.Fatal("populated metadata rollback allowed")
	}
	if c, e := f.connections.Detail(f.base.ctx, f.actor, clientAID, connectionID(1)); e != nil || c.ID == "" {
		t.Fatal("refused rollback lost metadata", e)
	}
}

func TestIntegrationMetadataEmptyDownUpPreservesHistoryAndRequiresRegrant(t *testing.T) {
	f := newConnectionFixture(t)
	var before, after string
	fingerprint := `SELECT md5(string_agg(row_to_json(e)::text,'' ORDER BY id)) FROM app.audit_events e`
	if e := f.admin.QueryRow(f.base.ctx, fingerprint).Scan(&before); e != nil {
		t.Fatal(e)
	}
	p := provider(t, f.base)
	if _, e := p.Down(f.base.ctx); e != nil {
		t.Fatal(e)
	}
	if _, e := p.Up(f.base.ctx); e != nil {
		t.Fatal(e)
	}
	if e := f.admin.QueryRow(f.base.ctx, fingerprint).Scan(&after); e != nil || before != after {
		t.Fatal("read migration changed audit history", e)
	}
	if _, e := f.connections.List(f.base.ctx, f.actor, clientAID, connections.Filter{Limit: 25}); e == nil {
		t.Fatal("recreated reader inherited runtime grant")
	}
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION app.integration_connection_list(uuid,uuid,uuid,integer),app.integration_connection_read(uuid,uuid,uuid) TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	if p, e := f.connections.List(f.base.ctx, f.actor, clientAID, connections.Filter{Limit: 25}); e != nil || len(p.Data) != 0 {
		t.Fatal("regrant failed", e)
	}
}

func TestIntegrationMetadataRollbackRetainsPermissionHistory(t *testing.T) {
	for _, kind := range []string{"custom", "revoked seed"} {
		t.Run(kind, func(t *testing.T) {
			f := newConnectionFixture(t)
			if kind == "custom" {
				if _, e := f.accounts.CreateRole(correlation.New(f.base.ctx), f.actor, "Metadata role", []authorization.Permission{authorization.IntegrationsView}); e != nil {
					t.Fatal(e)
				}
			} else if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE permission_key='integrations.view'`); e != nil {
				t.Fatal(e)
			}
			if _, e := provider(t, f.base).Down(f.base.ctx); e == nil {
				t.Fatal("permission history rollback allowed")
			}
			var n int
			if e := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.permissions WHERE permission_key='integrations.view'`).Scan(&n); e != nil || n != 1 {
				t.Fatal("permission history lost", e)
			}
		})
	}
}
