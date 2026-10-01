// Package administration owns bounded account/role administration, while
// identity and authorization retain credential/session and delegation policy.
package administration

import (
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/identity"
)

var (
	ErrInvalid           = errors.New("invalid administration input")
	ErrDenied            = errors.New("administration denied")
	ErrMissing           = errors.New("administration record not found")
	ErrConflict          = errors.New("administration revision or uniqueness conflict")
	ErrLastAdministrator = errors.New("last administrator protected")
	ErrSelfDisable       = errors.New("self disable refused")
	ErrSystemRole        = errors.New("system role is read only")
)

type User struct {
	ID          string     `json:"id"`
	Email       string     `json:"email"`
	DisplayName string     `json:"display_name"`
	Status      string     `json:"status"`
	Revision    int64      `json:"revision"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	LastLoginAt *time.Time `json:"last_login_at"`
}
type Role struct {
	ID          string                     `json:"id"`
	DisplayName string                     `json:"display_name"`
	SystemRole  bool                       `json:"system_role"`
	Revision    int64                      `json:"revision"`
	Permissions []authorization.Permission `json:"permissions"`
	CreatedAt   time.Time                  `json:"created_at"`
	UpdatedAt   time.Time                  `json:"updated_at"`
}
type Permission struct {
	Permission  authorization.Permission `json:"permission"`
	Scope       authorization.Scope      `json:"scope"`
	Description string                   `json:"description"`
}
type Assignment struct {
	ID          string              `json:"id"`
	UserID      string              `json:"user_id"`
	RoleID      string              `json:"role_id"`
	DisplayName string              `json:"display_name"`
	Scope       authorization.Scope `json:"scope"`
	ClientID    *string             `json:"client_id"`
	AssignedAt  time.Time           `json:"assigned_at"`
}
type Page[T any] struct {
	Data []T `json:"data"`
	Page struct {
		Limit      int     `json:"limit"`
		NextCursor *string `json:"next_cursor"`
	} `json:"page"`
}
type Mutation struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision,omitempty"`
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validID(id string) bool {
	return uuidPattern.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
}
func nullable(id string) any {
	if id == "" {
		return nil
	}
	return id
}
func newID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	bytes[6] = bytes[6]&0x0f | 0x40
	bytes[8] = bytes[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:]), nil
}
func validName(name string) bool {
	if !utf8.ValidString(name) || name != strings.TrimSpace(name) || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 100 {
		return false
	}
	for _, value := range name {
		if unicode.IsControl(value) {
			return false
		}
	}
	return true
}
func normalizeProfile(email, name string) (string, string, error) {
	email, name, err := identity.NormalizeProfile(email, name)
	if err != nil || !validName(name) {
		return "", "", ErrInvalid
	}
	return email, name, nil
}
func validPage(cursor string, limit int) bool {
	return (cursor == "" || validID(cursor)) && limit >= 1 && limit <= 100
}
func validPermissions(permissions []authorization.Permission) bool {
	if len(permissions) < 1 || len(permissions) > 100 {
		return false
	}
	seen := make(map[authorization.Permission]bool)
	for _, permission := range permissions {
		if !authorization.KnownPermission(permission) || seen[permission] {
			return false
		}
		seen[permission] = true
	}
	return true
}
