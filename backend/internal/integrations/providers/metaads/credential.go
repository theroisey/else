package metaads

import (
	"fmt"
	"regexp"
)

// ReadToken is an operator-provisioned user token. Parsing establishes only
// bounded Bearer syntax; every collection independently inspects ads_read.
type ReadToken struct{ value string }

var bearerToken = regexp.MustCompile(`^[A-Za-z0-9._~+/-]+={0,2}$`)

func ParseReadToken(raw []byte) (*ReadToken, error) {
	if len(raw) < 16 || len(raw) > 4096 || !bearerToken.Match(raw) {
		return nil, ErrInvalid
	}
	return &ReadToken{value: string(raw)}, nil
}

func (*ReadToken) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte("[private Meta read token]"))
}
func (*ReadToken) MarshalJSON() ([]byte, error) { return nil, ErrInvalid }

func (t *ReadToken) authorization() (string, bool) {
	if t == nil || len(t.value) < 16 || len(t.value) > 4096 || !bearerToken.MatchString(t.value) {
		return "", false
	}
	return "Bearer " + t.value, true
}
