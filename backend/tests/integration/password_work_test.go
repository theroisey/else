//go:build integration

package integration

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/theroisey/else/backend/internal/administration"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
)

// Only scheduling is controlled; actual Argon credentials/SQL/session/audit work
// remain real. No fake authorization or successful provider facts are supplied.
type heldArgonPasswords struct {
	entered chan struct{}
	release chan struct{}
}

func (p *heldArgonPasswords) Hash(password string) (string, error) {
	return (identity.ArgonPasswords{}).Hash(password)
}

func (p *heldArgonPasswords) Verify(encoded, password string) bool {
	p.entered <- struct{}{}
	<-p.release
	return (identity.ArgonPasswords{}).Verify(encoded, password)
}

func TestPasswordWorkBusyHandlersLeaveNoMutationAndRecover(t *testing.T) {
	f := newAdministrationFixture(t)
	inner := &heldArgonPasswords{entered: make(chan struct{}, 2), release: make(chan struct{})}
	bounded, err := identity.NewBoundedPasswords(inner)
	if err != nil {
		t.Fatal("private bounded password setup failed")
	}
	service, err := identity.NewService(f.runtime, bounded, f.authorizer)
	if err != nil {
		t.Fatal("private bounded identity setup failed")
	}
	accounts, err := administration.NewService(f.runtime, bounded)
	if err != nil {
		t.Fatal("private bounded administration setup failed")
	}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	auth, err := identity.NewHandler(service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal("private bounded auth handler unavailable")
	}
	admin, err := administration.NewHandler(accounts, auth, f.authorizer, logger)
	if err != nil {
		t.Fatal("private bounded admin handler unavailable")
	}
	f.handler = httpapi.RequestMiddleware(logger, admin)
	state := func() [3]string {
		t.Helper()
		var hashes [3]string
		for index, table := range []string{"users", "sessions", "audit_events"} {
			if f.admin.QueryRow(f.base.ctx, `SELECT md5(coalesce(string_agg(to_jsonb(r)::text,',' ORDER BY to_jsonb(r)::text),'')) FROM app.`+table+` r`).Scan(&hashes[index]) != nil {
				t.Fatal("private password-work state unavailable")
			}
		}
		return hashes
	}
	counts := func() [3]int64 {
		t.Helper()
		var values [3]int64
		for index, table := range []string{"users", "sessions", "audit_events"} {
			if f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app."+table).Scan(&values[index]) != nil {
				t.Fatal("private password-work count unavailable")
			}
		}
		return values
	}
	before, countBefore := state(), counts()
	var once sync.Once
	release := func() { once.Do(func() { close(inner.release) }) }
	var workers sync.WaitGroup
	errorsOut := make(chan error, 2)
	t.Cleanup(func() { release(); workers.Wait() })
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, err := service.Login(correlation.New(f.base.ctx), bootstrapEmail, bootstrapPassword)
			errorsOut <- err
		}()
	}
	for range 2 {
		select {
		case <-inner.entered:
		case <-f.base.ctx.Done():
			t.Fatal("private password workers did not enter")
		}
	}
	assertBusy := func(w *httptest.ResponseRecorder) {
		t.Helper()
		var value struct {
			Error struct {
				Code, Message string
				RequestID     string `json:"request_id"`
			} `json:"error"`
		}
		if json.Unmarshal(w.Body.Bytes(), &value) != nil || w.Code != 503 || value.Error.Code != "service_busy" || value.Error.Message != "This operation is temporarily unavailable. Try again." ||
			value.Error.RequestID == "" || value.Error.RequestID != w.Header().Get("X-Request-ID") || w.Header().Get("Retry-After") != "1" || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
			t.Fatal("busy response is not fixed safe unavailable state")
		}
	}
	for _, email := range []string{bootstrapEmail, "synthetic.unknown@example.com"} {
		body, _ := json.Marshal(map[string]string{"email": email, "password": bootstrapPassword})
		r := httptest.NewRequest(http.MethodPost, "https://else.example/api/v1/auth/login", bytes.NewReader(body))
		r.Header.Set("Origin", "https://else.example")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		httpapi.RequestMiddleware(logger, auth).ServeHTTP(w, r)
		assertBusy(w)
	}
	input := map[string]string{"email": "synthetic.busy@example.com", "display_name": "Synthetic busy user", "password": bootstrapPassword}
	assertBusy(f.request(t, &f.login, http.MethodPost, "users", input, nil))
	if state() != before {
		t.Fatal("busy login/admin work changed users/sessions/audit")
	}
	release()
	workers.Wait()
	close(errorsOut)
	for err := range errorsOut {
		if err != nil {
			t.Fatal("real verified login did not recover")
		}
	}
	w := f.request(t, &f.login, http.MethodPost, "users", input, nil)
	if w.Code != http.StatusCreated {
		t.Fatal("admin password work did not recover")
	}
	if counts() != [3]int64{countBefore[0] + 1, countBefore[1] + 2, countBefore[2] + 3} {
		t.Fatal("recovered login/admin mutations/audits are not exact")
	}
	for _, forbidden := range []string{bootstrapEmail, bootstrapPassword, "synthetic.busy@example.com", f.login.Token, f.login.CSRF} {
		if strings.Contains(logs.String(), forbidden) {
			t.Fatal("password-work logs exposed private input")
		}
	}
}
