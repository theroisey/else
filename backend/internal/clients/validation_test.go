package clients

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProfileValidationBoundsAndNormalization(t *testing.T) {
	p, err := normalize(Profile{Name: " Synthetic Client ", Contacts: []Contact{{Name: " Contact ", Email: "CONTACT@example.com"}}, Tags: []string{" Priority "}})
	if err != nil || p.Name != "Synthetic Client" || p.Contacts[0].Email != "contact@example.com" || p.Tags[0] != "priority" {
		t.Fatal("normalization failed")
	}
	for _, p := range []Profile{{}, {Name: strings.Repeat("x", 201)}, {Name: "bad\nname"}, {Name: "ok", Website: "javascript:alert(1)"}, {Name: "ok", Website: "https://user:password@example.com"}, {Name: "ok", Website: "https://example.com/#token"}, {Name: "ok", Notes: strings.Repeat("x", 4001)}, {Name: "ok", Contacts: make([]Contact, 21)}, {Name: "ok", Contacts: []Contact{{Name: "ok", Email: "invalid"}}}, {Name: "ok", Tags: []string{"tag", "TAG"}}} {
		if _, err := normalize(p); err == nil {
			t.Fatal("invalid profile accepted")
		}
	}
}
func TestBoundedFilterAndStrictBody(t *testing.T) {
	for _, query := range []string{"limit=0", "limit=101", "limit=1&limit=2", "status=deleted", "sort=name", "cursor=not-a-uuid", "actor=forged", "q=", "q=" + strings.Repeat("x", 101), "limit=%zz"} {
		r := httptest.NewRequest("GET", "/api/v1/clients?"+query, nil)
		if _, err := filter(r); err == nil {
			t.Fatal("invalid filter accepted")
		}
	}
	for _, body := range []string{`{"name":"ok","actor_id":"forged"}`, `{"name":"ok"}{}`, `{"name":"ok","contacts":[{"name":"ok","secret":"x"}]}`, strings.Repeat(" ", 65537) + `{}`} {
		r := httptest.NewRequest("POST", "/api/v1/clients", strings.NewReader(body))
		w := httptest.NewRecorder()
		var p Profile
		if decode(w, r, &p) || w.Code != 400 {
			t.Fatal("invalid body accepted")
		}
	}
	f, err := filter(httptest.NewRequest("GET", "/api/v1/clients?status=all&sort=-id&tag=Priority&q=Synthetic&limit=100", nil))
	if err != nil || f.Tag != "priority" || f.Limit != 100 {
		t.Fatal("valid filter failed")
	}
}
