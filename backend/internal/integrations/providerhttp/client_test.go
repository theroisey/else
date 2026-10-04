package providerhttp

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type lookup func(context.Context, string, string) ([]netip.Addr, error)

func (f lookup) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return f(ctx, network, host)
}

type fixture struct {
	client *Client
	server *httptest.Server
	dialed chan string
	roots  *x509.CertPool
}

func tlsFixture(t *testing.T, handler http.HandlerFunc, gate *Admission, resolve resolver, hostname string) *fixture {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	certificate := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{hostname}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	server := httptest.NewUnstartedServer(handler)
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS12}
	server.StartTLS()
	t.Cleanup(server.Close)
	if gate == nil {
		gate = NewAdmission()
	}
	if resolve == nil {
		resolve = lookup(func(_ context.Context, network, host string) ([]netip.Addr, error) {
			if network != "ip" || host != "shop.example.com" {
				return nil, errors.New("synthetic bad resolution")
			}
			return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
		})
	}
	f := &fixture{server: server, dialed: make(chan string, 32), roots: roots}
	client, err := newClient("https://shop.example.com/store", gate, resolve, func(ctx context.Context, network, address string) (net.Conn, error) {
		f.dialed <- address
		// Explicit isolated test mapping; production dialing has no such hook.
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}, roots)
	if err != nil {
		t.Fatal(err)
	}
	f.client = client
	return f
}

func TestCanonicalOriginsAndProductionConfiguration(t *testing.T) {
	for _, origin := range []string{"https://shop.example.com", "https://shop.example.com/store_1/catalog-2", "https://analyticsdata.googleapis.com"} {
		client, err := New(origin, NewAdmission())
		if err != nil {
			t.Fatal("canonical trusted origin rejected")
		}
		transport := client.state.http.Transport.(*http.Transport)
		if transport.Proxy != nil || transport.TLSClientConfig.InsecureSkipVerify || transport.TLSClientConfig.ServerName != "" || transport.TLSClientConfig.RootCAs != nil || transport.TLSClientConfig.MinVersion < tls.VersionTLS12 || !transport.DisableCompression || !transport.DisableKeepAlives {
			t.Fatal("unsafe production transport configuration")
		}
		for _, format := range []string{"%v", "%+v", "%#v", "%q", "%x"} {
			if strings.Contains(fmt.Sprintf(format, client), "shop") || strings.Contains(fmt.Sprintf(format, client), "googleapis") {
				t.Fatal("client formatting exposed private origin")
			}
		}
	}
	for _, origin := range []string{"http://shop.example.com", "https://shop.example.com/", "https://Shop.example.com", "https://shop.example.com:443", "https://user:synthetic-secret@shop.example.com", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://shop.example.com?token=synthetic-secret", "https://shop.example.com/#x", "https://shop.example.com/a%2fb", "https://shop.example.com/a/../b", "https://shop..example.com", "https://-shop.example.com", "https://" + strings.Repeat("a", 64) + ".com", "https://shop.example.com/" + strings.Repeat("x", 256)} {
		if client, err := New(origin, NewAdmission()); client != nil || err != ErrUnavailable {
			t.Fatal("unsafe origin accepted")
		}
	}
	if client, err := New("https://shop.example.com", nil); client != nil || err != ErrUnavailable {
		t.Fatal("unshared admission accepted")
	}
}

func TestConservativePublicAddressPolicy(t *testing.T) {
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"} {
		if !public(netip.MustParseAddr(raw)) {
			t.Fatal("ordinary public destination rejected")
		}
	}
	for _, raw := range []string{"0.1.2.3", "10.1.2.3", "100.64.1.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.0.0.9", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::a00:1", "2001::1", "2001:db8::1", "2002:7f00:1::1", "::ffff:127.0.0.1", "2606:4700::1%eth0"} {
		if public(netip.MustParseAddr(raw)) {
			t.Fatal("special-use/private destination accepted")
		}
	}
	if public(netip.Addr{}) {
		t.Fatal("invalid destination accepted")
	}
}

func TestPinnedHTTPSHostnameHeadersAndSecretFreeURL(t *testing.T) {
	seen := make(chan bool, 1)
	secret := "synthetic-key:synthetic-secret"
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte(secret))
	f := tlsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		seen <- r.TLS != nil && r.TLS.ServerName == "shop.example.com" && r.Host == "shop.example.com" && r.URL.Path == "/store/wp-json/wc/v3/orders" && r.URL.Query().Get("page") == "1" && r.Header.Get("Authorization") == auth && !strings.Contains(r.URL.String(), "synthetic") && r.Header.Get("Cookie") == "" && r.Header.Get("Proxy-Authorization") == "" && r.Header.Get("Accept-Encoding") == ""
		w.Header().Set("Content-Type", "application/json; charset=UTF-8")
		_, _ = io.WriteString(w, `{"safe":true}`)
	}, nil, nil, "shop.example.com")
	body, err := f.client.Do(context.Background(), "GET", "/wp-json/wc/v3/orders", url.Values{"page": {"1"}}, nil, auth, "")
	if err != nil || string(body) != `{"safe":true}` || !<-seen || <-f.dialed != "8.8.8.8:443" {
		t.Fatal("trusted pinned HTTPS request contract failed")
	}
}

func TestDNSAnswersFailClosedAndAreRevalidated(t *testing.T) {
	var calls atomic.Int32
	f := tlsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `[]`)
	}, nil, lookup(func(context.Context, string, string) ([]netip.Addr, error) {
		if calls.Add(1) == 1 {
			return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}), "shop.example.com")
	if _, err := f.client.Do(context.Background(), "GET", "/orders", nil, nil, "", ""); err != nil {
		t.Fatal("initial public resolution failed")
	}
	if body, err := f.client.Do(context.Background(), "GET", "/orders", nil, nil, "", ""); body != nil || err != ErrUnavailable || calls.Load() != 2 || len(f.dialed) != 1 {
		t.Fatal("DNS rebinding reached a second destination")
	}
	for _, answers := range [][]netip.Addr{nil, {netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("10.0.0.1")}, {netip.Addr{}}, {netip.MustParseAddr("2001:db8::1")}, make([]netip.Addr, 9)} {
		var dials atomic.Int32
		client, err := newClient("https://shop.example.com", NewAdmission(), lookup(func(context.Context, string, string) ([]netip.Addr, error) { return answers, nil }), func(context.Context, string, string) (net.Conn, error) {
			dials.Add(1)
			return nil, errors.New("synthetic private dial detail")
		}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if body, err := client.Do(context.Background(), "GET", "/orders", nil, nil, "", ""); body != nil || err != ErrUnavailable || dials.Load() != 0 {
			t.Fatal("unsafe DNS answer dialed or exposed detail")
		}
	}
}

func TestTLSHostnameAndTrustCannotBeBypassed(t *testing.T) {
	f := tlsFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("wrong-host certificate reached handler") }, nil, nil, "different.example.com")
	if body, err := f.client.Do(context.Background(), "GET", "/orders", nil, nil, "Bearer synthetic-private-token", ""); body != nil || err != ErrUnavailable {
		t.Fatal("wrong TLS hostname accepted")
	}
	f = tlsFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted certificate reached handler") }, nil, nil, "shop.example.com")
	f.client.state.http.Transport.(*http.Transport).TLSClientConfig.RootCAs = x509.NewCertPool()
	if body, err := f.client.Do(context.Background(), "GET", "/orders", nil, nil, "", ""); body != nil || err != ErrUnavailable {
		t.Fatal("untrusted TLS certificate accepted")
	}
}

func TestRedirectStatusContentEncodingAndBodyLimits(t *testing.T) {
	var requests atomic.Int32
	f := tlsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/store/redirect":
			w.Header().Set("Location", "https://127.0.0.1/private?token=synthetic-secret")
			w.WriteHeader(302)
		case "/store/status":
			w.WriteHeader(401)
			_, _ = io.WriteString(w, `{"private":"synthetic-secret"}`)
		case "/store/type":
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, `{"safe":true}`)
		case "/store/encoding":
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = io.WriteString(w, `{"safe":true}`)
		case "/store/header":
			w.Header().Set("X-Synthetic", strings.Repeat("x", 20000))
			_, _ = io.WriteString(w, `{}`)
		case "/store/empty":
		case "/store/json":
			_, _ = io.WriteString(w, `{"incomplete":`)
		case "/store/utf8":
			_, _ = w.Write([]byte{'"', 0xff, '"'})
		case "/store/limit":
			_, _ = io.WriteString(w, `"`+strings.Repeat("x", MaxResponseBytes-2)+`"`)
		case "/store/large":
			_, _ = io.WriteString(w, `"`+strings.Repeat("x", MaxResponseBytes-1)+`"`)
		case "/store/chunked":
			w.(http.Flusher).Flush()
			_, _ = io.WriteString(w, `"`+strings.Repeat("x", MaxResponseBytes-1)+`"`)
		}
	}, nil, nil, "shop.example.com")
	for _, path := range []string{"redirect", "status", "type", "encoding", "header", "empty", "json", "utf8", "large", "chunked"} {
		before := requests.Load()
		if body, err := f.client.Do(context.Background(), "GET", "/"+path, nil, nil, "Bearer synthetic-private-token", ""); body != nil || err != ErrUnavailable || err.Error() != "provider request unavailable" || requests.Load() != before+1 {
			t.Fatal("unsafe HTTP response or retry escaped fixed boundary")
		}
	}
	if body, err := f.client.Do(context.Background(), "GET", "/limit", nil, nil, "", ""); err != nil || len(body) != MaxResponseBytes {
		t.Fatal("exact response boundary rejected")
	}
}

func TestRequestInputBoundsPrecedeDNSAndAdmission(t *testing.T) {
	var calls atomic.Int32
	client, err := newClient("https://shop.example.com", NewAdmission(), lookup(func(context.Context, string, string) ([]netip.Addr, error) {
		calls.Add(1)
		return nil, errors.New("synthetic private resolver detail")
	}), func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("invalid request dialed")
		return nil, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path      string
		query             url.Values
		body              []byte
		auth, contentType string
	}{
		{"DELETE", "/orders", nil, nil, "", ""}, {"GET", "//private.example.com", nil, nil, "", ""}, {"GET", "/../private", nil, nil, "", ""}, {"GET", "/orders?access_token=synthetic-secret", nil, nil, "", ""}, {"GET", "/orders%2Fprivate", nil, nil, "", ""},
		{"GET", "/orders", url.Values{"access_token": {"synthetic-secret"}}, nil, "", ""}, {"GET", "/orders", url.Values{"page": {"1", "2"}}, nil, "", ""}, {"GET", "/orders", nil, []byte("body"), "", ""}, {"POST", "/report", nil, make([]byte, MaxRequestBytes+1), "", ""}, {"GET", "/orders", nil, nil, "Bearer synthetic\r\nHost: private", ""}, {"GET", "/orders", nil, nil, "Basic " + strings.Repeat("x", 4096), ""}, {"POST", "/report", nil, nil, "", "text/plain"},
	} {
		if body, err := client.Do(context.Background(), tc.method, tc.path, tc.query, tc.body, tc.auth, tc.contentType); body != nil || err != ErrUnavailable {
			t.Fatal("unsafe request accepted")
		}
	}
	if calls.Load() != 0 || len(client.state.admission.slots) != 0 {
		t.Fatal("invalid request consumed provider capacity")
	}
	if body, err := client.Do(nil, "GET", "/orders", nil, nil, "", ""); body != nil || err != ErrUnavailable {
		t.Fatal("nil context accepted")
	}
}

func TestSharedAdmissionCountsActualBodyLifetimeCancellationAndRecovery(t *testing.T) {
	entered := make(chan struct{}, 3)
	release := make(chan struct{})
	gate := NewAdmission()
	f := tlsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"safe":`)
		w.(http.Flusher).Flush()
		entered <- struct{}{}
		select {
		case <-release:
			_, _ = io.WriteString(w, `true}`)
		case <-r.Context().Done():
		}
	}, gate, nil, "shop.example.com")
	second, err := newClient("https://shop.example.com/store", gate, lookup(func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}), func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, f.server.Listener.Addr().String())
	}, f.roots)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	results := make(chan error, 2)
	go func() { _, err := f.client.Do(ctx, "GET", "/orders", nil, nil, "", ""); results <- err }()
	go func() { _, err := second.Do(ctx, "GET", "/orders", nil, nil, "", ""); results <- err }()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for range 2 {
		select {
		case <-entered:
		case <-deadline.C:
			t.Fatal("admitted requests did not reach body read")
		}
	}
	if body, err := second.Do(context.Background(), "GET", "/orders", nil, nil, "", ""); body != nil || err != ErrBusy || len(gate.slots) != 2 {
		t.Fatal("shared body-read capacity escaped")
	}
	cancel()
	for range 2 {
		select {
		case err := <-results:
			if err != ErrUnavailable {
				t.Fatal("canceled request returned success")
			}
		case <-deadline.C:
			t.Fatal("cancellation did not release request")
		}
	}
	if len(gate.slots) != 0 {
		t.Fatal("canceled request retained capacity")
	}
	close(release)
	if body, err := second.Do(context.Background(), "GET", "/orders", nil, nil, "", ""); err != nil || string(body) != `{"safe":true}` {
		t.Fatal("provider capacity failed to recover")
	}
}

func TestRequestBudgetCoversDNSAndResponseBody(t *testing.T) {
	client, err := newClient("https://shop.example.com", NewAdmission(), lookup(func(ctx context.Context, _, _ string) ([]netip.Addr, error) {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > requestBudget {
			t.Error("request budget absent from DNS")
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}), func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("timed-out DNS dialed")
		return nil, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if body, err := client.Do(ctx, "GET", "/orders", nil, nil, "", ""); body != nil || err != ErrUnavailable || len(client.state.admission.slots) != 0 {
		t.Fatal("DNS timeout lost safe error or slot")
	}
	ctx, cancel = context.WithCancel(context.Background())
	cancel()
	if body, err := client.Do(ctx, "GET", "/orders", nil, nil, "", ""); body != nil || err != ErrUnavailable {
		t.Fatal("pre-canceled request admitted")
	}
}
