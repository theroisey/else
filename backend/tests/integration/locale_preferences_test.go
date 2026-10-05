//go:build integration

package integration

import (
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/theroisey/else/backend/internal/config"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
)

func TestLocalePreferencesSelfServiceCSRFAndPersistence(t *testing.T) {
	f := newAdministrationFixture(t)
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION app.user_locale_read(uuid),app.user_locale_write(uuid,text) TO `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	h, err := identity.NewHandler(f.service, config.Auth{PublicOrigin: "https://else.example", CookieSecure: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = httpapi.RequestMiddleware(logger, h)
	assertStatus(t, f.request(t, &f.login, "GET", "auth/preferences", nil, nil), 200, "")
	for _, locale := range []string{"en", "tr", "ro", "de", "fr"} {
		w := f.request(t, &f.login, "PUT", "auth/preferences", map[string]any{"locale": locale}, nil)
		assertStatus(t, w, 200, "")
		w = f.request(t, &f.login, "GET", "auth/preferences", nil, nil)
		assertStatus(t, w, 200, "")
		if !strings.Contains(w.Body.String(), `"locale":"`+locale+`"`) {
			t.Fatal("preference not persisted")
		}
	}
	assertStatus(t, f.request(t, &f.login, "PUT", "auth/preferences", map[string]any{"locale": "xx"}, nil), 400, "invalid_request")
	assertStatus(t, f.request(t, &f.login, "PUT", "auth/preferences", map[string]any{"locale": "tr", "user_id": f.actor}, nil), 400, "invalid_request")
	assertStatus(t, f.request(t, nil, "GET", "auth/preferences", nil, nil), 401, "authentication_required")
	assertStatus(t, f.request(t, &f.login, "PUT", "auth/preferences", map[string]any{"locale": "tr"}, func(r *http.Request) { r.Header.Set("X-CSRF-Token", "wrong") }), 403, "csrf_failed")
	var count int
	if err = f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.audit_events WHERE resource_kind='user_preference' AND resource_id=$1::uuid`, f.actor).Scan(&count); err != nil || count != 5 {
		t.Fatal("preference writes not audited", err)
	}
	if _, err = provider(t, f.base).DownTo(f.base.ctx, 26); err == nil {
		t.Fatal("preference history rolled back silently")
	}
}
