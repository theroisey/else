package ga4

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/theroisey/else/backend/internal/integrations/providerhttp"
)

const readScope = "https://www.googleapis.com/auth/analytics.readonly"
const tokenOrigin = "https://oauth2.googleapis.com"
const tokenEndpoint = tokenOrigin + "/token"

var ErrAuthorizationUnavailable = errors.New("GA4 authorization unavailable")
var serviceEmail = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,127}@[a-z0-9][a-z0-9-]{0,62}\.iam\.gserviceaccount\.com$`)
var serviceKeyID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// ServiceAccount is private backend credential state. Its normal Google key
// document may be accepted only from an authorized setup or protected vault read.
// Arbitrary endpoints, universe domains, impersonation and direct JWT access are
// deliberately unsupported. Possession of this key does not establish property
// authorization or account ownership.
type ServiceAccount struct {
	email, keyID string
	key          *rsa.PrivateKey
}

func (*ServiceAccount) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte("[redacted GA4 credential]"))
}
func (*ServiceAccount) MarshalJSON() ([]byte, error) { return nil, ErrAuthorizationUnavailable }

func ParseServiceAccount(raw []byte) (*ServiceAccount, error) {
	if len(raw) == 0 || len(raw) > 16<<10 {
		return nil, ErrAuthorizationUnavailable
	}
	fields, ok := object(raw, "type", "project_id", "private_key_id", "private_key", "client_email", "client_id", "auth_uri", "token_uri", "auth_provider_x509_cert_url", "client_x509_cert_url", "universe_domain")
	if !ok || !exactString(fields["type"], "service_account") || !exactString(fields["token_uri"], tokenEndpoint) {
		return nil, ErrAuthorizationUnavailable
	}
	// Optional unused metadata must still be scalar strings. Never use its URLs
	// for discovery, certificates, token exchange or browser redirect targets.
	for name, value := range fields {
		var scalar string
		if !stringValue(value, &scalar) || len(scalar) > 12<<10 {
			return nil, ErrAuthorizationUnavailable
		}
		if name == "universe_domain" && scalar != "googleapis.com" {
			return nil, ErrAuthorizationUnavailable
		}
	}
	var email, keyID, privatePEM string
	if !stringValue(fields["client_email"], &email) || !serviceEmail.MatchString(email) || !stringValue(fields["private_key_id"], &keyID) || !serviceKeyID.MatchString(keyID) || !stringValue(fields["private_key"], &privatePEM) {
		return nil, ErrAuthorizationUnavailable
	}
	block, rest := pem.Decode([]byte(privatePEM))
	if block == nil || block.Type != "PRIVATE KEY" || len(block.Headers) != 0 || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, ErrAuthorizationUnavailable
	}
	defer clear(block.Bytes)
	if !boundedRSAKey(block.Bytes) {
		return nil, ErrAuthorizationUnavailable
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, ErrAuthorizationUnavailable
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok || key.N == nil || key.N.BitLen() < 2048 || key.N.BitLen() > 4096 || key.E != 65537 || len(key.Primes) != 2 || key.Validate() != nil {
		return nil, ErrAuthorizationUnavailable
	}
	return &ServiceAccount{email, keyID, key}, nil
}

// Bound RSA integers before x509 validates/precomputes attacker-supplied ASN.1.
// The official key document uses two-prime PKCS#8 RSA with a conventional exponent.
func boundedRSAKey(der []byte) bool {
	var container struct {
		Version   int
		Algorithm pkix.AlgorithmIdentifier
		Key       []byte
	}
	rest, err := asn1.Unmarshal(der, &container)
	if err != nil || len(rest) != 0 || container.Version != 0 || !container.Algorithm.Algorithm.Equal(asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 1}) {
		return false
	}
	var key struct {
		Version                   int
		N                         *big.Int
		E                         int
		D, P, Q, DP, DQ, QInverse *big.Int
		Extra                     asn1.RawValue `asn1:"optional"`
	}
	rest, err = asn1.Unmarshal(container.Key, &key)
	if err != nil || len(rest) != 0 || len(key.Extra.FullBytes) != 0 || key.Version != 0 || key.E != 65537 || key.N == nil || key.N.BitLen() < 2048 || key.N.BitLen() > 4096 {
		return false
	}
	for _, number := range []*big.Int{key.N, key.D, key.P, key.Q, key.DP, key.DQ, key.QInverse} {
		if number == nil || number.Sign() <= 0 || number.BitLen() > 4096 {
			return false
		}
	}
	return true
}

// AccessToken cannot be serialized or formatted into logs. Only trusted backend
// provider code should obtain its Authorization header; never return it in DTOs.
type AccessToken struct {
	value   string
	expires time.Time
}

func (AccessToken) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte("[redacted GA4 access token]"))
}
func (AccessToken) MarshalJSON() ([]byte, error) { return nil, ErrAuthorizationUnavailable }
func (t AccessToken) Authorization(now time.Time) (string, error) {
	if t.value == "" || now.IsZero() || !now.Before(t.expires.Add(-30*time.Second)) {
		return "", ErrAuthorizationUnavailable
	}
	return "Bearer " + t.value, nil
}

func (s *ServiceAccount) assertion(now time.Time) (string, error) {
	if s == nil || s.key == nil || !serviceEmail.MatchString(s.email) || !serviceKeyID.MatchString(s.keyID) || now.Year() < 2000 || now.Year() > 9998 {
		return "", ErrAuthorizationUnavailable
	}
	header, err := json.Marshal(struct {
		Algorithm string `json:"alg"`
		Type      string `json:"typ"`
		KeyID     string `json:"kid"`
	}{"RS256", "JWT", s.keyID})
	if err != nil {
		return "", ErrAuthorizationUnavailable
	}
	claims, err := json.Marshal(struct {
		Issuer   string `json:"iss"`
		Scope    string `json:"scope"`
		Audience string `json:"aud"`
		Issued   int64  `json:"iat"`
		Expires  int64  `json:"exp"`
	}{s.email, readScope, tokenEndpoint, now.Unix(), now.Add(time.Hour).Unix()})
	if err != nil {
		return "", ErrAuthorizationUnavailable
	}
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, s.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", ErrAuthorizationUnavailable
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

type tokenTransport interface {
	Do(context.Context, string, string, url.Values, []byte, string, string) ([]byte, error)
}

// Exchange always constructs the verified fixed-origin transport. It supplies no
// caller endpoint, redirect hook, fake resolver, ambient proxy or trust override.
// Execute in a bounded background operation, never a user dashboard request.
// No cache, refresh loop or automatic business retry is supplied by this method.
func (s *ServiceAccount) Exchange(ctx context.Context, gate *providerhttp.Admission) (AccessToken, error) {
	client, err := providerhttp.New(tokenOrigin, gate)
	if err != nil {
		return AccessToken{}, ErrAuthorizationUnavailable
	}
	return s.exchange(ctx, client, time.Now().UTC())
}

func (s *ServiceAccount) exchange(ctx context.Context, client tokenTransport, now time.Time) (AccessToken, error) {
	if ctx == nil || ctx.Err() != nil || client == nil {
		return AccessToken{}, ErrAuthorizationUnavailable
	}
	assertion, err := s.assertion(now)
	if err != nil {
		return AccessToken{}, ErrAuthorizationUnavailable
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	response, err := client.Do(ctx, "POST", "/token", nil, []byte(form.Encode()), "", "application/x-www-form-urlencoded")
	defer clear(response)
	if err != nil || ctx.Err() != nil || len(response) == 0 || len(response) > 64<<10 {
		return AccessToken{}, ErrAuthorizationUnavailable
	}
	fields, ok := object(response, "access_token", "token_type", "expires_in", "scope")
	if !ok || !exactString(fields["token_type"], "Bearer") {
		return AccessToken{}, ErrAuthorizationUnavailable
	}
	if scope, present := fields["scope"]; present && !exactString(scope, readScope) {
		return AccessToken{}, ErrAuthorizationUnavailable
	}
	var token string
	if !stringValue(fields["access_token"], &token) || len(token) == 0 || len(token) > 2048 {
		return AccessToken{}, ErrAuthorizationUnavailable
	}
	for _, char := range []byte(token) {
		if char < 33 || char > 126 {
			return AccessToken{}, ErrAuthorizationUnavailable
		}
	}
	if !integer.Match(fields["expires_in"]) {
		return AccessToken{}, ErrAuthorizationUnavailable
	}
	seconds, err := strconv.Atoi(string(fields["expires_in"]))
	if err != nil || seconds < 60 || seconds > 3600 {
		return AccessToken{}, ErrAuthorizationUnavailable
	}
	return AccessToken{token, now.Add(time.Duration(seconds) * time.Second)}, nil
}
