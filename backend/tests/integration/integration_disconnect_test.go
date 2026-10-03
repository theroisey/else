//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/budget"
	"github.com/theroisey/else/backend/internal/integrations/connections"
	"github.com/theroisey/else/backend/internal/integrations/vault"
)

const disconnectFunction = `app.integration_local_disconnect(uuid,uuid,uuid,bigint)`

func newDisconnectFixture(t *testing.T) *vaultFixture {
	t.Helper()
	f := newVaultFixture(t)
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+disconnectFunction+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	return f
}
func disconnectPath(client, connection string) string {
	return metadataPath(client) + "/" + connection + "/disconnect"
}
func disconnectBody(revision string) map[string]any {
	return map[string]any{"revision": revision, "confirmed": true}
}
func (f *vaultFixture) connectionMarkers(t *testing.T) (string, int64, int64) {
	t.Helper()
	var state string
	var revision, generation int64
	if e := f.admin.QueryRow(f.base.ctx, `SELECT state,revision,generation FROM app.integration_connections WHERE id=$1::uuid`, connectionID(1)).Scan(&state, &revision, &generation); e != nil {
		t.Fatal(e)
	}
	return state, revision, generation
}

func TestIntegrationDisconnectHTTPHonestOutcomeFencesAndRecovery(t *testing.T) {
	f := newDisconnectFixture(t)
	ctx := correlation.New(f.base.ctx)
	c := f.replace(t, f.checkpoint(t), "synthetic-retained-token")
	path := disconnectPath(clientAID, connectionID(1))
	w := f.request(t, &f.login, "POST", path, disconnectBody("2"), nil)
	assertStatus(t, w, 200, "")
	var result struct {
		Data       map[string]json.RawMessage `json:"data"`
		Revocation connections.Revocation     `json:"revocation"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil || len(result.Data) != 7 || result.Revocation.Status != "unavailable" || !result.Revocation.ManualActionRequired {
		t.Fatal("response implied remote revocation success")
	}
	if state, revision, generation := f.connectionMarkers(t); state != "revocation_failed" || revision != 3 || generation != c.Generation+1 {
		t.Fatal("local generation fence missing")
	}
	if f.stored(t, f.ring) != "synthetic-retained-token" {
		t.Fatal("disconnect deleted revocation material")
	}
	if _, e := f.budget.Seal(ctx, f.actor, clientAID, connectionID(1), []byte("synthetic")); e != budget.ErrMissing {
		t.Fatal("disabled connection still encrypts", e)
	}
	if _, e := f.vault.Replace(ctx, f.actor, clientAID, connectionID(1), c, []byte("synthetic")); e != vault.ErrMissing {
		t.Fatal("disabled connection still stores", e)
	}
	if _, e := f.vault.Rewrap(ctx, f.actor, clientAID, connectionID(1), c); e != vault.ErrMissing {
		t.Fatal("disabled connection still rotates", e)
	}
	if n, events := f.accounting(t); n != 1 || events != 1 {
		t.Fatal("disconnect changed encryption accounting")
	}
	// An original lost-response retry conflicts. GET reconciles the committed state.
	assertStatus(t, f.request(t, &f.login, "POST", path, disconnectBody("2"), nil), 409, "conflict")
	assertStatus(t, f.request(t, &f.login, "GET", metadataPath(clientAID)+"/"+connectionID(1), nil, nil), 200, "")
	repeated := f.request(t, &f.login, "POST", path, disconnectBody("3"), nil)
	assertStatus(t, repeated, 200, "")
	if repeated.Body.String() != w.Body.String() {
		t.Fatal("current revision repetition changed outcome")
	}
	if a, b := f.mutationEvents(t); a != 1 || b != 2 {
		t.Fatal("no-op or failure wrote an audit")
	}
	var raw string
	if e := f.admin.QueryRow(ctx, `SELECT row_to_json(e)::text FROM app.audit_events e WHERE resource_kind='integration_connection' AND metadata->>'source'='http'`).Scan(&raw); e != nil {
		t.Fatal(e)
	}
	var event struct {
		EventName string         `json:"event_name"`
		Before    map[string]any `json:"before_state"`
		After     map[string]any `json:"after_state"`
	}
	if e := json.Unmarshal([]byte(raw), &event); e != nil || event.EventName != "integration_connection.updated" || len(event.Before) != 2 || len(event.After) != 2 || event.Before["revision"] != float64(2) || event.After["revision"] != float64(3) {
		t.Fatal("disconnect audit markers incorrect")
	}
	for _, private := range []string{"synthetic-retained-token", "synthetic-primary", "990001", "envelope", "generation", "fingerprint", "integration.disconnected"} {
		if strings.Contains(raw, private) || strings.Contains(w.Body.String(), private) || strings.Contains(f.logs.String(), private) {
			t.Fatal("secret or remote-success claim leaked")
		}
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("mutation response cacheable")
	}
}

func TestIntegrationDisconnectHTTPVerificationAndStrictInput(t *testing.T) {
	f := newDisconnectFixture(t)
	path := disconnectPath(clientAID, connectionID(1))
	assertStatus(t, f.request(t, nil, "POST", path, disconnectBody("1"), nil), 401, "authentication_required")
	for _, test := range []struct {
		alter  func(*http.Request)
		status int
		code   string
	}{
		{func(r *http.Request) { r.Header.Del("X-CSRF-Token") }, 403, "csrf_failed"},
		{func(r *http.Request) { r.Header.Set("Origin", "https://other.example") }, 403, "origin_forbidden"},
		{func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415, "content_type_required"},
	} {
		w := f.request(t, &f.login, "POST", path, disconnectBody("1"), test.alter)
		assertStatus(t, w, test.status, test.code)
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("error cacheable")
		}
	}
	for _, body := range []string{`null`, `[]`, `{}`, `{"revision":1,"confirmed":true}`, `{"revision":"1","confirmed":false}`, `{"revision":"1","confirmed":true,"Confirmed":true}`, `{"revision":"1","confirmed":true,"confirmed":true}`, `{"revision":"1","confirmed":true,"revision":"1"}`, `{"revision":"1","confirmed":true} {}`, `{"revision":"01","confirmed":true}`, `{"revision":"1","confirmed":true,"token":"synthetic"}`, strings.Repeat(" ", 1025) + `{"revision":"1","confirmed":true}`} {
		w := f.request(t, &f.login, "POST", path, nil, func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(body)) })
		assertStatus(t, w, 400, "invalid_request")
	}
	for _, badPath := range []string{path + "?x=1", path + "?", disconnectPath("bad", connectionID(1)), disconnectPath(clientAID, "bad")} {
		assertStatus(t, f.request(t, &f.login, "POST", badPath, disconnectBody("1"), nil), 400, "invalid_request")
	}
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		w := f.request(t, &f.login, method, path, nil, nil)
		assertStatus(t, w, 405, "method_not_allowed")
		if w.Header().Get("Allow") != "POST" {
			t.Fatal("disconnect method contract changed")
		}
	}
	for _, oldPath := range []string{metadataPath(clientAID), metadataPath(clientAID) + "/" + connectionID(1)} {
		w := f.request(t, &f.login, "POST", oldPath, disconnectBody("1"), nil)
		assertStatus(t, w, 405, "method_not_allowed")
		if w.Header().Get("Allow") != "GET" {
			t.Fatal("metadata became generally writable")
		}
	}
	if state, revision, generation := f.connectionMarkers(t); state != "pending" || revision != 1 || generation != 1 {
		t.Fatal("invalid request changed metadata")
	}
	user := f.user(t, "disconnect-disabled@example.com")
	login, e := f.service.Login(correlation.New(f.base.ctx), "disconnect-disabled@example.com", bootstrapPassword)
	if e != nil {
		t.Fatal(e)
	}
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, user.ID); e != nil {
		t.Fatal(e)
	}
	assertStatus(t, f.request(t, &login, "POST", path, disconnectBody("1"), nil), 401, "authentication_required")
}

func TestIntegrationDisconnectExactGrantsOwnershipStateAndOverflow(t *testing.T) {
	for _, permissions := range [][]authorization.Permission{{authorization.ClientsView, authorization.IntegrationsView}, {authorization.ClientsView, authorization.IntegrationsManage}, {authorization.IntegrationsView, authorization.IntegrationsManage}, {authorization.ClientsView, authorization.IntegrationsView, authorization.AnalyticsView}, {authorization.ClientsView, authorization.IntegrationsView, authorization.IntegrationsManage}} {
		t.Run(fmt.Sprint(permissions), func(t *testing.T) {
			f := newDisconnectFixture(t)
			ctx := correlation.New(f.base.ctx)
			actor, _ := f.grant(t, permissions, clientAID)
			allowed := len(permissions) == 3 && permissions[2] == authorization.IntegrationsManage
			result, e := f.connections.Disconnect(ctx, actor, clientAID, connectionID(1), "1")
			if allowed {
				if e != nil || result.Data.State != "revocation_failed" {
					t.Fatal(e)
				}
			} else if e != connections.ErrMissing {
				t.Fatal("incomplete grants allowed", e)
			}
			for _, target := range []struct{ client, connection string }{{clientBID, connectionID(1)}, {clientAID, connectionID(2)}} {
				if r, e := f.connections.Disconnect(ctx, actor, target.client, target.connection, "1"); e != connections.ErrMissing || r.Data.ID != "" {
					t.Fatal("foreign/missing connection disclosed", e)
				}
			}
		})
	}
	for _, state := range []string{"pending", "connected", "reauthorization_required", "disconnect_pending", "revocation_failed", "disconnected"} {
		t.Run(state, func(t *testing.T) {
			f := newDisconnectFixture(t)
			ctx := correlation.New(f.base.ctx)
			if _, e := f.admin.Exec(ctx, `UPDATE app.integration_connections SET state=$1 WHERE id=$2::uuid`, state, connectionID(1)); e != nil {
				t.Fatal(e)
			}
			_, e := f.connections.Disconnect(ctx, f.actor, clientAID, connectionID(1), "1")
			if state == "disconnected" {
				if e != connections.ErrConflict {
					t.Fatal("terminal state reinterpreted", e)
				}
			} else if e != nil {
				t.Fatal(e)
			}
			_, revision, generation := f.connectionMarkers(t)
			want := int64(2)
			if state == "revocation_failed" || state == "disconnected" {
				want = 1
			}
			if revision != want || generation != want {
				t.Fatal("incorrect transition or no-op fence")
			}
		})
	}
	for _, column := range []string{"revision", "generation"} {
		t.Run(column, func(t *testing.T) {
			f := newDisconnectFixture(t)
			if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET `+column+`=9223372036854775807 WHERE id=$1::uuid`, connectionID(1)); e != nil {
				t.Fatal(e)
			}
			revision := "1"
			if column == "revision" {
				revision = "9223372036854775807"
			}
			if _, e := f.connections.Disconnect(correlation.New(f.base.ctx), f.actor, clientAID, connectionID(1), revision); e != connections.ErrConflict {
				t.Fatal("overflow permitted", e)
			}
			if state, _, _ := f.connectionMarkers(t); state != "pending" {
				t.Fatal("overflow partially disabled")
			}
		})
	}
	f := newDisconnectFixture(t)
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID); e != nil {
		t.Fatal(e)
	}
	if _, e := f.connections.Disconnect(correlation.New(f.base.ctx), f.actor, clientAID, connectionID(1), "1"); e != connections.ErrMissing {
		t.Fatal("archived client mutated", e)
	}
}

func TestIntegrationDisconnectAuditCommitFailureAndConcurrentRequests(t *testing.T) {
	for _, mode := range []string{"audit", "commit"} {
		t.Run(mode, func(t *testing.T) {
			f := newDisconnectFixture(t)
			ctx := correlation.New(f.base.ctx)
			f.replace(t, f.checkpoint(t), "synthetic")
			if mode == "audit" {
				if _, e := f.admin.Exec(ctx, `REVOKE INSERT `+auditColumns+` ON app.audit_events FROM `+f.runtimeRole); e != nil {
					t.Fatal(e)
				}
			} else {
				if _, e := f.admin.Exec(ctx, `CREATE FUNCTION app.test_disconnect_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='synthetic-private-error'; END $$;
   CREATE CONSTRAINT TRIGGER test_disconnect_commit_failure AFTER UPDATE ON app.integration_connections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.test_disconnect_commit_failure()`); e != nil {
					t.Fatal(e)
				}
			}
			w := f.request(t, &f.login, "POST", disconnectPath(clientAID, connectionID(1)), disconnectBody("2"), nil)
			assertStatus(t, w, 500, "internal_error")
			if state, revision, generation := f.connectionMarkers(t); state != "pending" || revision != 2 || generation != 2 {
				t.Fatal("audit/commit failure left fence")
			}
			if f.stored(t, f.ring) != "synthetic" {
				t.Fatal("failed disconnect altered credential")
			}
			if a, b := f.mutationEvents(t); a != 1 || b != 1 {
				t.Fatal("failed disconnect left partial event")
			}
			if n, events := f.accounting(t); n != 1 || events != 1 {
				t.Fatal("failed disconnect altered accounting")
			}
			if strings.Contains(w.Body.String(), "synthetic-private-error") || strings.Contains(f.logs.String(), "synthetic-private-error") {
				t.Fatal("raw commit error leaked")
			}
		})
	}
	f := newDisconnectFixture(t)
	ctx := correlation.New(f.base.ctx)
	answers := make(chan error, 2)
	for range 2 {
		go func() { _, e := f.connections.Disconnect(ctx, f.actor, clientAID, connectionID(1), "1"); answers <- e }()
	}
	success, conflicts := 0, 0
	for range 2 {
		e := <-answers
		if e == nil {
			success++
		} else if e == connections.ErrConflict {
			conflicts++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatal("concurrent disconnect bypassed CAS")
	}
	if a, b := f.mutationEvents(t); a != 0 || b != 1 {
		t.Fatal("concurrent failure emitted event")
	}
}

func TestIntegrationDisconnectQueuesFreshChecksAndFencesEncryptedStorage(t *testing.T) {
	for _, scenario := range []string{"clients.view", "integrations.view", "integrations.manage", "disabled", "archive", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			f := newDisconnectFixture(t)
			actor, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsView, authorization.IntegrationsManage}, clientAID)
			ctx, cancel := context.WithTimeout(correlation.New(f.base.ctx), 8*time.Second)
			defer cancel()
			tx, e := f.admin.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback(f.base.ctx)
			if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); e != nil {
				t.Fatal(e)
			}
			if scenario == "disabled" {
				_, e = tx.Exec(ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, actor)
			} else if scenario == "archive" {
				_, e = tx.Exec(ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID)
			} else if scenario != "cancel" {
				_, e = tx.Exec(ctx, `UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id=(SELECT role_id FROM app.user_roles WHERE id=$1::uuid) AND permission_key=$2`, assignment, scenario)
			}
			if e != nil {
				t.Fatal(e)
			}
			answers := make(chan error, 1)
			go func() {
				r, e := f.connections.Disconnect(ctx, actor, clientAID, connectionID(1), "1")
				if r.Data.ID != "" {
					answers <- fmt.Errorf("denied disconnect returned metadata")
					return
				}
				answers <- e
			}()
			waitBudgetLock(t, ctx, f.adminPool)
			if scenario == "cancel" {
				cancel()
				if e = <-answers; e != connections.ErrUnavailable {
					t.Fatal(e)
				}
				_ = tx.Rollback(f.base.ctx)
			} else {
				if e = tx.Commit(ctx); e != nil {
					t.Fatal(e)
				}
				if e = <-answers; e != connections.ErrMissing {
					t.Fatal("stale authority used", e)
				}
			}
			if state, revision, generation := f.connectionMarkers(t); state != "pending" || revision != 1 || generation != 1 {
				t.Fatal("queued denial mutated state")
			}
		})
	}
	f := newDisconnectFixture(t)
	ctx := correlation.New(f.base.ctx)
	c := f.checkpoint(t)
	blocker := f.blockWrite(t, ctx)
	answers := make(chan error, 1)
	go func() {
		_, e := f.vault.Replace(ctx, f.actor, clientAID, connectionID(1), c, []byte("synthetic-do-not-publish"))
		answers <- e
	}()
	waitVaultWriters(t, ctx, f.adminPool, 1)
	if _, e := f.connections.Disconnect(ctx, f.actor, clientAID, connectionID(1), "1"); e != nil {
		t.Fatal(e)
	}
	if e := blocker.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e := <-answers; e != vault.ErrMissing {
		t.Fatal("already encrypted work crossed real disconnect", e)
	}
	if n, events := f.accounting(t); n != 1 || events != 1 {
		t.Fatal("fenced storage refunded capacity")
	}
	if a, b := f.mutationEvents(t); a != 0 || b != 1 {
		t.Fatal("fenced ciphertext persisted audit")
	}
}

func TestIntegrationDisconnectPrivilegedEntryPointAndPopulatedRollback(t *testing.T) {
	f := newDisconnectFixture(t)
	ctx := correlation.New(f.base.ctx)
	f.replace(t, f.checkpoint(t), "synthetic")
	if _, e := f.connections.Disconnect(ctx, f.actor, clientAID, connectionID(1), "2"); e != nil {
		t.Fatal(e)
	}
	var secure, public bool
	if e := f.admin.QueryRow(ctx, `SELECT prosecdef AND provolatile='v' AND lower(array_to_string(proconfig,',')) LIKE '%search_path=pg_catalog%' AND lower(array_to_string(proconfig,',')) LIKE '%timezone=utc%', EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') FROM pg_proc WHERE oid=$1::regprocedure`, disconnectFunction).Scan(&secure, &public); e != nil || !secure || public {
		t.Fatal("unsafe disconnect definer", e)
	}
	p := provider(t, f.base)
	if _, e := p.Down(ctx); e != nil {
		t.Fatal(e)
	}
	if state, revision, generation := f.connectionMarkers(t); state != "revocation_failed" || revision != 3 || generation != 3 {
		t.Fatal("entrypoint rollback lost state")
	}
	if f.stored(t, f.ring) != "synthetic" {
		t.Fatal("entrypoint rollback lost credential")
	}
	if a, b := f.mutationEvents(t); a != 1 || b != 2 {
		t.Fatal("entrypoint rollback lost audits")
	}
	if _, e := p.Up(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e := f.connections.Disconnect(ctx, f.actor, clientAID, connectionID(1), "3"); e != connections.ErrUnavailable {
		t.Fatal("recreated entrypoint retained grant", e)
	}
	if _, e := f.admin.Exec(ctx, `GRANT EXECUTE ON FUNCTION `+disconnectFunction+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	if _, e := f.connections.Disconnect(ctx, f.actor, clientAID, connectionID(1), "3"); e != nil {
		t.Fatal("regrant no-op failed", e)
	}
	if a, b := f.mutationEvents(t); a != 1 || b != 2 {
		t.Fatal("restored no-op emitted audit")
	}
	// Raw data remains absent from the public response even after down/up.
	w := f.request(t, &f.login, "POST", disconnectPath(clientAID, connectionID(1)), disconnectBody("3"), nil)
	if bytes.Contains(w.Body.Bytes(), []byte("synthetic")) {
		t.Fatal("retained material exposed")
	}
}
