package woocommerce

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func readKeyFixture() string {
	return `{"consumer_key":"ck_` + strings.Repeat("a", 40) + `","consumer_secret":"cs_` + strings.Repeat("b", 40) + `"}`
}

func TestReadCredentialSyntaxAuthorizationAndRedaction(t *testing.T) {
	key, err := ParseReadKey([]byte(readKeyFixture()))
	if err != nil {
		t.Fatal("provisioned read key rejected")
	}
	header, ok := key.authorization()
	if !ok || !strings.HasPrefix(header, "Basic ") {
		t.Fatal("read credential did not use Basic header")
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(header, "Basic "))
	if err != nil || string(decoded) != "ck_"+strings.Repeat("a", 40)+":cs_"+strings.Repeat("b", 40) {
		t.Fatal("read credential binding changed")
	}
	clear(decoded)
	for _, format := range []string{"%v", "%+v", "%#v", "%q", "%x"} {
		if fmt.Sprintf(format, key) != "<WooCommerce read credential>" {
			t.Fatal("read credential formatted")
		}
	}
	if _, err := json.Marshal(key); err == nil {
		t.Fatal("read credential serialized")
	}
	if _, ok := (*ReadKey)(nil).authorization(); ok {
		t.Fatal("nil credential authorized")
	}
}

func TestReadCredentialRejectsExpandedOrMalformedValues(t *testing.T) {
	for _, raw := range []string{
		"", "null", "[]", readKeyFixture() + "{}", strings.Repeat(" ", 1025) + readKeyFixture(),
		strings.Replace(readKeyFixture(), `"consumer_key"`, `"consumer_key":null,"consumer_key"`, 1),
		strings.Replace(readKeyFixture(), `"consumer_secret"`, `"consumer_secret":null,"consumer_secr\u0065t"`, 1),
		strings.Replace(readKeyFixture(), `"ck_`, `"CK_`, 1),
		strings.Replace(readKeyFixture(), `"ck_`, `"https://shop.example.com/`, 1),
		strings.Replace(readKeyFixture(), strings.Repeat("a", 40), strings.Repeat("0", 40), 1),
		strings.Replace(readKeyFixture(), strings.Repeat("b", 40), strings.Repeat("0", 40), 1),
		strings.Replace(readKeyFixture(), strings.Repeat("b", 40), strings.Repeat("b", 39), 1),
		strings.Replace(readKeyFixture(), `}`, `,"origin":"https://foreign.example"}`, 1),
		strings.Replace(readKeyFixture(), `}`, `,"permissions":"read_write"}`, 1),
	} {
		key, err := ParseReadKey([]byte(raw))
		if err != ErrUnavailable || key != nil {
			t.Fatal("malformed credential exposed partial data")
		}
	}
}
