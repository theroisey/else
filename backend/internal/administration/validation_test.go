package administration

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/theroisey/else/backend/internal/authorization"
)

func TestProfileValidationAndNormalization(t *testing.T) {
	email, name, err := normalizeProfile(" SYNTHETIC@EXAMPLE.COM ", " Synthetic User ")
	if err != nil || email != "synthetic@example.com" || name != "Synthetic User" {
		t.Fatal("profile normalization failed")
	}
	for _, input := range []struct{ email, name string }{{"invalid", "Name"}, {"user@example.com", ""}, {"user@example.com", "Name\nControl"}, {"user@example.com", strings.Repeat("ü", 101)}} {
		if _, _, err := normalizeProfile(input.email, input.name); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid profile accepted")
		}
	}
	for _, keys := range [][]authorization.Permission{nil, {authorization.UsersView, authorization.UsersView}, {"unknown.permission"}} {
		if validPermissions(keys) {
			t.Fatal("invalid permission selection accepted")
		}
	}
}

func TestStrictMutationDecodingRejectsUntrustedFieldsAndOversizedBodies(t *testing.T) {
	for _, raw := range []string{`{"confirm":true,"actor_id":"spoof"}`, `{"confirm":true} {}`, `{"confirm":true`, strings.Repeat(" ", 16*1024) + `{"confirm":true}`} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(raw))
		w := httptest.NewRecorder()
		var input struct {
			Confirm bool `json:"confirm"`
		}
		if decode(w, r, &input) || w.Code != 400 {
			t.Fatal("untrusted request body accepted")
		}
	}
}

func TestUnexpectedFailuresExposeOnlySafeDiagnosticMarkers(t *testing.T) {
	var logs bytes.Buffer
	h := Handler{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/v1/users", nil)
	h.fail(w, r, errors.New("password=synthetic-secret SQL detail"))
	if w.Code != 500 || strings.Contains(w.Body.String()+logs.String(), "synthetic-secret") || strings.Contains(logs.String(), "SQL detail") {
		t.Fatal("internal failure leaked sensitive details")
	}
}
