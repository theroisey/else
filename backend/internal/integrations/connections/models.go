// Package connections owns secret-free integration connection metadata reads.
package connections

import (
	"encoding/base64"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var ErrInvalid = errors.New("invalid integration metadata request")
var ErrMissing = errors.New("integration metadata unavailable")

type Connection struct {
	ID        string    `json:"id"`
	ClientID  string    `json:"client_id"`
	Provider  string    `json:"provider"`
	State     string    `json:"state"`
	Revision  string    `json:"revision"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
type Filter struct {
	Limit  int
	Cursor string
}
type Pagination struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"next_cursor"`
}
type Page struct {
	Data []Connection `json:"data"`
	Page Pagination   `json:"page"`
}

var uuid = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validID(id string) bool {
	return uuid.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
}
func validConnection(c Connection, client string) bool {
	n, e := strconv.ParseInt(c.Revision, 10, 64)
	if !validID(c.ID) || c.ID != strings.ToLower(c.ID) || c.ClientID != client || c.Provider != "meta_ads" || e != nil || n < 1 || strconv.FormatInt(n, 10) != c.Revision {
		return false
	}
	switch c.State {
	case "pending", "connected", "disconnect_pending", "revocation_failed", "disconnected", "reauthorization_required":
	default:
		return false
	}
	return c.CreatedAt.Year() >= 1 && c.CreatedAt.Year() <= 9999 && c.UpdatedAt.Year() >= 1 && c.UpdatedAt.Year() <= 9999 &&
		!c.UpdatedAt.Before(c.CreatedAt) && c.CreatedAt.Nanosecond()%1000 == 0 && c.UpdatedAt.Nanosecond()%1000 == 0
}
func encodeCursor(client, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte("v1|" + client + "|" + id))
}
func decodeCursor(client, raw string) (any, error) {
	if raw == "" {
		return nil, nil
	}
	if len(raw) > 128 {
		return nil, ErrInvalid
	}
	data, e := base64.RawURLEncoding.Strict().DecodeString(raw)
	if e != nil || base64.RawURLEncoding.EncodeToString(data) != raw {
		return nil, ErrInvalid
	}
	parts := strings.Split(string(data), "|")
	if len(parts) != 3 || parts[0] != "v1" || parts[1] != client || !validID(parts[2]) || parts[2] != strings.ToLower(parts[2]) {
		return nil, ErrInvalid
	}
	return parts[2], nil
}
