package woocommerce

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/theroisey/else/backend/internal/integrations/providers/internal/jsonvalue"
)

var consumerKey = regexp.MustCompile(`^ck_[a-f0-9]{40}$`)
var consumerSecret = regexp.MustCompile(`^cs_[a-f0-9]{40}$`)

// ReadKey is a privately held provisioned WooCommerce credential. Syntax alone
// cannot prove the key's vendor permissions: operators must create a Read key.
// This adapter uses only GET, regardless of privileges actually granted remotely.
type ReadKey struct{ key, secret string }

func (k *ReadKey) String() string               { return "<WooCommerce read credential>" }
func (k *ReadKey) Format(s fmt.State, _ rune)   { _, _ = io.WriteString(s, k.String()) }
func (k *ReadKey) MarshalJSON() ([]byte, error) { return nil, ErrUnavailable }

// ParseReadKey rejects expanded/duplicate credentials and has no origin/URL input.
// Caller-owned plaintext bytes must be cleared; strings remain GC-managed.
func ParseReadKey(raw []byte) (*ReadKey, error) {
	if len(raw) == 0 || len(raw) > 1024 {
		return nil, ErrUnavailable
	}
	fields, ok := jsonvalue.Object(raw, "consumer_key", "consumer_secret")
	if !ok || len(fields) != 2 {
		return nil, ErrUnavailable
	}
	var key, secret string
	if json.Unmarshal(fields["consumer_key"], &key) != nil || json.Unmarshal(fields["consumer_secret"], &secret) != nil ||
		!consumerKey.MatchString(key) || !consumerSecret.MatchString(secret) || strings.Trim(key[3:], "0") == "" || strings.Trim(secret[3:], "0") == "" {
		return nil, ErrUnavailable
	}
	return &ReadKey{key: key, secret: secret}, nil
}

func (k *ReadKey) authorization() (string, bool) {
	if k == nil || !consumerKey.MatchString(k.key) || !consumerSecret.MatchString(k.secret) {
		return "", false
	}
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(k.key+":"+k.secret)), true
}
