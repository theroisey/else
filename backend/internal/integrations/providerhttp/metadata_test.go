package providerhttp

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestExplicitMetadataBudgetPreservesOrdinaryAndChunkedBounds(t *testing.T) {
	for _, limit := range []int{0, 1, MaxResponseBytes - 1, MaxMetadataResponseBytes + 1} {
		if client, err := NewWithResponseLimit("https://shop.example.com", NewAdmission(), limit); client != nil || err != ErrUnavailable {
			t.Fatal("unreviewed body budget accepted")
		}
	}
	exact := `{"value":"` + strings.Repeat("x", MaxMetadataResponseBytes-len(`{"value":""}`)) + `"}`
	f := tlsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(exact))
	}, nil, nil, "shop.example.com")
	if data, err := f.client.Do(context.Background(), "GET", "/metadata", nil, nil, "", ""); data != nil || err != ErrUnavailable {
		t.Fatal("ordinary 64 KiB report budget widened")
	}
	f.client.state.responseLimit = MaxMetadataResponseBytes
	if data, err := f.client.Do(context.Background(), "GET", "/metadata", nil, nil, "", ""); err != nil || string(data) != exact {
		t.Fatal("exact metadata budget unavailable")
	}
	oversized := exact + " "
	f = tlsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.(http.Flusher).Flush()
		w.Write([]byte(oversized))
	}, nil, nil, "shop.example.com")
	f.client.state.responseLimit = MaxMetadataResponseBytes
	if data, err := f.client.Do(context.Background(), "GET", "/metadata", nil, nil, "", ""); data != nil || err != ErrUnavailable {
		t.Fatal("oversized chunked metadata or partial body accepted")
	}
}
