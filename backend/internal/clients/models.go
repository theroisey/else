// Package clients owns client profiles and their exact-scope persistence boundary.
package clients

import (
	"crypto/rand"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/theroisey/else/backend/internal/identity"
)

var (
	ErrInvalid  = errors.New("invalid client input")
	ErrMissing  = errors.New("client unavailable")
	ErrDenied   = errors.New("client operation denied")
	ErrConflict = errors.New("client revision or archive conflict")
)

type Contact struct {
	Name  string `json:"name"`
	Email string `json:"email"`
	Phone string `json:"phone"`
}
type Profile struct {
	Name      string    `json:"name"`
	LegalName string    `json:"legal_name"`
	Website   string    `json:"website"`
	Notes     string    `json:"notes"`
	Contacts  []Contact `json:"contacts"`
	Tags      []string  `json:"tags"`
}
type Summary struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	LegalName  string     `json:"legal_name"`
	Status     string     `json:"status"`
	Revision   int64      `json:"revision"`
	Tags       []string   `json:"tags"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
	ArchivedAt *time.Time `json:"archived_at"`
}
type Client struct {
	Summary
	Website  string    `json:"website"`
	Notes    string    `json:"notes"`
	Contacts []Contact `json:"contacts"`
}
type Mutation struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}
type Filter struct {
	Cursor string
	Limit  int
	Status string
	Search string
	Tag    string
	Sort   string
}
type Page struct {
	Data []Summary `json:"data"`
	Page struct {
		Limit      int     `json:"limit"`
		NextCursor *string `json:"next_cursor"`
	} `json:"page"`
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validID(id string) bool {
	return uuidPattern.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
}
func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
func validText(s string, max int, required bool) bool {
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > max || (required && s == "") {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func normalize(p Profile) (Profile, error) {
	p.Name = strings.TrimSpace(p.Name)
	p.LegalName = strings.TrimSpace(p.LegalName)
	p.Website = strings.TrimSpace(p.Website)
	p.Notes = strings.TrimSpace(p.Notes)
	if !validText(p.Name, 200, true) || !validText(p.LegalName, 200, false) || !validText(p.Notes, 4000, false) || !validText(p.Website, 2048, false) || len(p.Contacts) > 20 || len(p.Tags) > 20 {
		return Profile{}, ErrInvalid
	}
	if p.Website != "" {
		u, err := url.Parse(p.Website)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
			return Profile{}, ErrInvalid
		}
	}
	// Copy slices so normalization never changes the caller's buffers.
	p.Contacts = append([]Contact{}, p.Contacts...)
	p.Tags = append([]string{}, p.Tags...)
	for i, c := range p.Contacts {
		c.Name = strings.TrimSpace(c.Name)
		c.Email = strings.TrimSpace(c.Email)
		c.Phone = strings.TrimSpace(c.Phone)
		if !validText(c.Name, 100, true) || !validText(c.Phone, 40, false) {
			return Profile{}, ErrInvalid
		}
		if c.Email != "" {
			var err error
			c.Email, _, err = identity.NormalizeProfile(c.Email, c.Name)
			if err != nil {
				return Profile{}, ErrInvalid
			}
		}
		p.Contacts[i] = c
	}
	seen := map[string]bool{}
	for i, tag := range p.Tags {
		tag = strings.ToLower(strings.TrimSpace(tag))
		if !validText(tag, 40, true) || seen[tag] {
			return Profile{}, ErrInvalid
		}
		seen[tag] = true
		p.Tags[i] = tag
	}
	return p, nil
}
func validFilter(f Filter) bool {
	return (f.Cursor == "" || validID(f.Cursor)) && f.Limit >= 1 && f.Limit <= 100 && (f.Status == "active" || f.Status == "archived" || f.Status == "all") && (f.Sort == "id" || f.Sort == "-id") && validText(f.Search, 100, false) && validText(f.Tag, 40, false)
}
