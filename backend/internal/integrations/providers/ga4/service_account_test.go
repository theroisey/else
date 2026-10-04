package ga4

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"
)

type syntheticTokenTransport struct {
	body    []byte
	err     error
	calls   int
	request func(context.Context, string, string, url.Values, []byte, string, string)
}

func (s *syntheticTokenTransport) Do(ctx context.Context, method, path string, query url.Values, body []byte, authorization, contentType string) ([]byte, error) {
	s.calls++
	if s.request != nil {
		s.request(ctx, method, path, query, body, authorization, contentType)
	}
	return append([]byte(nil), s.body...), s.err
}

func serviceAccountFixture(t *testing.T) (*rsa.PrivateKey, map[string]string, []byte) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(der)
	document := map[string]string{"type": "service_account", "client_email": "synthetic@sample-project.iam.gserviceaccount.com", "private_key_id": "synthetic-key-id", "private_key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "token_uri": tokenEndpoint, "universe_domain": "googleapis.com"}
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return key, document, raw
}

func TestServiceAccountUsesSignedAssertionWithOneReadScopeAndFixedAudience(t *testing.T) {
	key, document, raw := serviceAccountFixture(t)
	defer clear(raw)
	account, err := ParseServiceAccount(raw)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 4, 10, 0, 0, 0, time.UTC)
	transport := &syntheticTokenTransport{body: []byte(`{"access_token":"synthetic.private-token","token_type":"Bearer","expires_in":3600}`)}
	transport.request = func(_ context.Context, method, path string, query url.Values, body []byte, authorization, contentType string) {
		if method != "POST" || path != "/token" || len(query) != 0 || authorization != "" || contentType != "application/x-www-form-urlencoded" {
			t.Fatal("unexpected token transport contract")
		}
		form, err := url.ParseQuery(string(body))
		if err != nil || len(form) != 2 || form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
			t.Fatal("unexpected grant")
		}
		parts := strings.Split(form.Get("assertion"), ".")
		if len(parts) != 3 {
			t.Fatal("invalid JWT")
		}
		decode := func(value string) map[string]any {
			data, err := base64.RawURLEncoding.Strict().DecodeString(value)
			if err != nil {
				t.Fatal(err)
			}
			var result map[string]any
			if json.Unmarshal(data, &result) != nil {
				t.Fatal("invalid JWT JSON")
			}
			return result
		}
		header, claims := decode(parts[0]), decode(parts[1])
		if len(header) != 3 || header["alg"] != "RS256" || header["typ"] != "JWT" || header["kid"] != document["private_key_id"] {
			t.Fatal("unexpected signing header")
		}
		if len(claims) != 5 || claims["iss"] != document["client_email"] || claims["aud"] != tokenEndpoint || claims["scope"] != readScope || claims["iat"] != float64(now.Unix()) || claims["exp"] != float64(now.Add(time.Hour).Unix()) {
			t.Fatal("scope/audience/time/impersonation boundary failed")
		}
		signature, err := base64.RawURLEncoding.Strict().DecodeString(parts[2])
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		if rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], signature) != nil {
			t.Fatal("JWT signature failed")
		}
		if strings.Contains(string(body), "PRIVATE KEY") {
			t.Fatal("key document leaked to token request")
		}
	}
	token, err := account.exchange(context.Background(), transport, now)
	if err != nil || transport.calls != 1 {
		t.Fatal("exchange failed")
	}
	header, err := token.Authorization(now)
	if err != nil || header != "Bearer synthetic.private-token" {
		t.Fatal("access header unavailable")
	}
	if _, err = token.Authorization(now.Add(time.Hour - 30*time.Second)); err != ErrAuthorizationUnavailable {
		t.Fatal("near-expired token accepted")
	}
	for _, value := range []any{account, token} {
		for _, format := range []string{"%v", "%+v", "%#v", "%s"} {
			if !strings.HasPrefix(fmt.Sprintf(format, value), "[redacted GA4 ") {
				t.Fatal("credential/token formatting leaked")
			}
		}
		if data, err := json.Marshal(value); err == nil || len(data) != 0 {
			t.Fatal("credential/token serialization accepted")
		}
	}
}

func TestServiceAccountRejectsDiscoveryImpersonationAndMalformedKeys(t *testing.T) {
	_, document, raw := serviceAccountFixture(t)
	defer clear(raw)
	for _, tc := range []struct{ name, value string }{
		{"token_uri", "https://private.example/token"}, {"universe_domain", "private.example"}, {"type", "authorized_user"},
		{"client_email", "synthetic@private.example"}, {"private_key_id", "private\r\nheader"}, {"subject", "impersonated@example.com"},
		{"audience", "https://private.example"}, {"private_key", "private malformed PEM"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			copy := map[string]string{}
			for k, v := range document {
				copy[k] = v
			}
			copy[tc.name] = tc.value
			data, _ := json.Marshal(copy)
			defer clear(data)
			account, err := ParseServiceAccount(data)
			if account != nil || err != ErrAuthorizationUnavailable {
				t.Fatal("unsafe credential accepted")
			}
		})
	}
	for _, data := range [][]byte{nil, []byte(`null`), append(raw, raw...), []byte(`{"type":"service_account","type":"service_account"}`), make([]byte, (16<<10)+1)} {
		if account, err := ParseServiceAccount(data); account != nil || err != ErrAuthorizationUnavailable {
			t.Fatal("invalid document accepted")
		}
	}
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(ec)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(der)
	document["private_key"] = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	data, _ := json.Marshal(document)
	if account, err := ParseServiceAccount(data); account != nil || err != ErrAuthorizationUnavailable {
		t.Fatal("unsupported signing key accepted")
	}
}

func TestServiceAccountTokenErrorsRemainPrivateAndAtomic(t *testing.T) {
	_, _, raw := serviceAccountFixture(t)
	defer clear(raw)
	account, err := ParseServiceAccount(raw)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 4, 10, 0, 0, 0, time.UTC)
	for _, body := range []string{
		`{"error":"private-provider-diagnostic"}`,
		`{"access_token":"private","token_type":"Bearer","expires_in":3600,"scope":"https://www.googleapis.com/auth/analytics.edit"}`,
		`{"access_token":"private","token_type":"bearer","expires_in":3600}`,
		`{"access_token":"private","token_type":"Bearer","expires_in":"3600"}`,
		`{"access_token":"private","token_type":"Bearer","expires_in":1e3}`,
		`{"access_token":"private","token_type":"Bearer","expires_in":59}`,
		`{"access_token":"private","token_type":"Bearer","expires_in":3601}`,
		`{"access_token":"private\r\nheader","token_type":"Bearer","expires_in":3600}`,
		`{"access_token":"private","access_token":"other","token_type":"Bearer","expires_in":3600}`,
		`{"access_token":"private","token_type":"Bearer","expires_in":3600,"id_token":"private"}`,
	} {
		transport := &syntheticTokenTransport{body: []byte(body)}
		token, err := account.exchange(context.Background(), transport, now)
		if token.value != "" || err != ErrAuthorizationUnavailable || transport.calls != 1 {
			t.Fatal("partial token/private failure/retry boundary failed")
		}
	}
	transport := &syntheticTokenTransport{err: errors.New("private-provider-diagnostic")}
	if token, err := account.exchange(context.Background(), transport, now); token.value != "" || err != ErrAuthorizationUnavailable || transport.calls != 1 {
		t.Fatal("transport error leaked")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	transport = &syntheticTokenTransport{}
	if token, err := account.exchange(ctx, transport, now); token.value != "" || err != ErrAuthorizationUnavailable || transport.calls != 0 {
		t.Fatal("canceled request executed")
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	transport = &syntheticTokenTransport{body: []byte(`{"access_token":"private","token_type":"Bearer","expires_in":3600}`), request: func(context.Context, string, string, url.Values, []byte, string, string) { cancel() }}
	if token, err := account.exchange(ctx, transport, now); token.value != "" || err != ErrAuthorizationUnavailable {
		t.Fatal("canceled response returned token")
	}
}
