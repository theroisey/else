package identity

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	passwordMemory  = 19 * 1024
	passwordTime    = 2
	passwordThreads = 1
	passwordKeyLen  = 32
	passwordSaltLen = 16
)

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrUnauthorized       = errors.New("authentication required")
	ErrInvalidInput       = errors.New("invalid identity input")
	emailPattern          = regexp.MustCompile(`^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)
)

type Passwords interface {
	Hash(string) (string, error)
	Verify(string, string) bool
}

type ArgonPasswords struct{}

func (ArgonPasswords) Hash(password string) (string, error) {
	if !validPassword(password) {
		return "", ErrInvalidInput
	}
	salt := make([]byte, passwordSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("password salt generation failed")
	}
	key := argon2.IDKey([]byte(password), salt, passwordTime, passwordMemory, passwordThreads, passwordKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, passwordMemory, passwordTime,
		passwordThreads, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func (ArgonPasswords) Verify(encoded, password string) bool {
	fields := strings.Split(encoded, "$")
	if len(fields) != 6 || fields[0] != "" || fields[1] != "argon2id" || fields[2] != "v=19" {
		return false
	}
	parameters := strings.Split(fields[3], ",")
	if len(parameters) != 3 {
		return false
	}
	memory, errM := parseParameter(parameters[0], "m=")
	timeCost, errT := parseParameter(parameters[1], "t=")
	threads, errP := parseParameter(parameters[2], "p=")
	if errM != nil || errT != nil || errP != nil || memory != passwordMemory || timeCost != passwordTime || threads != passwordThreads {
		return false
	}
	salt, err := base64.RawStdEncoding.Strict().DecodeString(fields[4])
	if err != nil || len(salt) != passwordSaltLen {
		return false
	}
	want, err := base64.RawStdEncoding.Strict().DecodeString(fields[5])
	if err != nil || len(want) != passwordKeyLen {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, uint32(timeCost), uint32(memory), uint8(threads), uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func parseParameter(value, prefix string) (uint64, error) {
	if !strings.HasPrefix(value, prefix) {
		return 0, ErrInvalidInput
	}
	return strconv.ParseUint(strings.TrimPrefix(value, prefix), 10, 32)
}

func validPassword(password string) bool {
	return utf8.ValidString(password) && len(password) >= 12 && len(password) <= 128
}

func canonicalEmail(value string) (string, bool) {
	value = strings.ToLower(strings.TrimSpace(value))
	return value, len(value) >= 3 && len(value) <= 254 && emailPattern.MatchString(value)
}

// NormalizeProfile shares identity's canonical email/name contract with the
// administration domain, without exposing credential internals.
func NormalizeProfile(email, name string) (string, string, error) {
	email, ok := canonicalEmail(email)
	name = strings.TrimSpace(name)
	if !ok || !validDisplayName(name) {
		return "", "", ErrInvalidInput
	}
	return email, name, nil
}

func validDisplayName(value string) bool {
	return utf8.ValidString(value) && value == strings.TrimSpace(value) && utf8.RuneCountInString(value) >= 1 && utf8.RuneCountInString(value) <= 100
}

func randomSecret() (raw string, digest [32]byte, err error) {
	value := make([]byte, 32)
	if _, err = rand.Read(value); err != nil {
		return "", digest, err
	}
	raw = base64.RawURLEncoding.EncodeToString(value)
	digest = sha256.Sum256(value)
	return raw, digest, nil
}

func secretDigest(raw string) ([32]byte, bool) {
	var zero [32]byte
	value, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil || len(value) != 32 {
		return zero, false
	}
	return sha256.Sum256(value), true
}

func newID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	encoded := hex.EncodeToString(value)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}
