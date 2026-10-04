//go:build integration

package integration

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestCompiledAPIRequestDeadlineRollbackAndRecovery(t *testing.T) {
	binary := buildCompiledAPI(t)
	f := newAdministrationFixture(t)
	api := startCompiledAPIWithRequestBudget(t, f, binary, 250*time.Millisecond)
	const marker = "synthetic-deadline-private-marker"
	defer func() {
		api.Close()
		for _, private := range []string{marker, f.login.Token, f.login.CSRF, f.runtime.Config().ConnConfig.Password} {
			if strings.Contains(api.Logs.String(), private) {
				t.Error("deadline logs exposed private input")
			}
		}
	}()
	fingerprint := func() [2]string {
		t.Helper()
		var state [2]string
		for index, table := range []string{"clients", "audit_events"} {
			if f.admin.QueryRow(f.base.ctx, `SELECT md5(coalesce(string_agg(to_jsonb(r)::text,',' ORDER BY to_jsonb(r)::text),'')) FROM app.`+table+` r`).Scan(&state[index]) != nil {
				t.Fatal("deadline state fingerprint unavailable")
			}
		}
		return state
	}
	request := func(method, body string, status int) {
		t.Helper()
		r, err := http.NewRequestWithContext(api.Context, method, api.Origin+"/api/v1/clients/"+clientAID, strings.NewReader(body))
		if err != nil {
			t.Fatal("private deadline request unavailable")
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", api.Origin)
		r.Header.Set("X-CSRF-Token", f.login.CSRF)
		r.AddCookie(&http.Cookie{Name: "else_session", Value: f.login.Token})
		r.AddCookie(&http.Cookie{Name: "else_csrf", Value: f.login.CSRF})
		started := time.Now()
		response, err := api.Client.Do(r)
		if err != nil {
			t.Fatal("compiled deadline response unavailable")
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
		if err != nil || len(data) > 65536 || response.StatusCode != status || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("compiled deadline bounded response differs: status=%d want=%d", response.StatusCode, status)
		}
		if status == 503 {
			var value struct {
				Error struct {
					Code, Message string
					RequestID     string `json:"request_id"`
				} `json:"error"`
			}
			if json.Unmarshal(data, &value) != nil || value.Error.Code != "request_timeout" || value.Error.Message != "The request timed out. Refresh before retrying." ||
				value.Error.RequestID == "" || value.Error.RequestID != response.Header.Get("X-Request-ID") || time.Since(started) >= 2*time.Second {
				t.Fatal("compiled API did not honor the earlier request deadline safely")
			}
			for _, private := range []string{marker, f.login.Token, f.login.CSRF, "SQLSTATE", "postgres", "password"} {
				if strings.Contains(string(data), private) {
					t.Fatal("deadline response exposed private detail")
				}
			}
		}
	}
	before := fingerprint()
	lock, err := f.admin.Begin(f.base.ctx)
	if err != nil {
		t.Fatal("private read lock unavailable")
	}
	defer lock.Rollback(f.base.ctx)
	if _, err := lock.Exec(f.base.ctx, "LOCK TABLE app.clients IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal("private read lock acquisition failed")
	}
	request(http.MethodGet, "", 503)
	if lock.Rollback(f.base.ctx) != nil || fingerprint() != before {
		t.Fatal("timed-out read changed state or failed recovery")
	}
	request(http.MethodGet, "", 200)
	var revision int64
	if f.admin.QueryRow(f.base.ctx, "SELECT revision FROM app.clients WHERE id=$1", clientAID).Scan(&revision) != nil {
		t.Fatal("private client revision unavailable")
	}
	mutation := fmt.Sprintf(`{"name":"%s","expected_revision":%d}`, marker, revision)
	lock, err = f.admin.Begin(f.base.ctx)
	if err != nil {
		t.Fatal("private mutation lock unavailable")
	}
	defer lock.Rollback(f.base.ctx)
	if _, err := lock.Exec(f.base.ctx, "SELECT id FROM app.clients WHERE id=$1 FOR UPDATE", clientAID); err != nil {
		t.Fatal("private mutation lock acquisition failed")
	}
	request(http.MethodPut, mutation, 503)
	if lock.Rollback(f.base.ctx) != nil || fingerprint() != before {
		t.Fatal("timed-out mutation left domain or audit changes")
	}
	request(http.MethodGet, "", 200)
	request(http.MethodPut, mutation, 200)
	var next, auditCount int64
	if f.admin.QueryRow(f.base.ctx, "SELECT revision FROM app.clients WHERE id=$1", clientAID).Scan(&next) != nil || next != revision+1 ||
		f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app.audit_events WHERE resource_kind='client' AND resource_id=$1 AND event_name='client.updated'", clientAID).Scan(&auditCount) != nil || auditCount != 1 {
		t.Fatal("normal mutation/audit did not recover exactly once")
	}
}
