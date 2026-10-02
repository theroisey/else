// Package reminders owns one-time, client-scoped schedules and their lifecycle.
package reminders

import (
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/theroisey/else/backend/internal/timezone"
)

var (
	ErrInvalid  = errors.New("invalid reminder input")
	ErrMissing  = errors.New("reminder or client unavailable")
	ErrConflict = errors.New("reminder revision or lifecycle conflict")
	ErrOwner    = errors.New("invalid reminder owner")
	ErrResource = errors.New("invalid reminder resource link")
	ErrSchedule = timezone.ErrSchedule
)

type Resource struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// Profile is the complete metadata request. Computed instants and state are
// deliberately excluded from the decoder's accepted fields.
type Profile struct {
	Title            string    `json:"title"`
	Description      string    `json:"description"`
	OwnerID          string    `json:"owner_id"`
	ScheduledLocal   string    `json:"scheduled_local"`
	Timezone         string    `json:"timezone"`
	UTCOffsetSeconds *int      `json:"utc_offset_seconds"`
	Resource         *Resource `json:"resource"`
}

type Summary struct {
	ID               string     `json:"id"`
	ClientID         string     `json:"client_id"`
	CreatedBy        string     `json:"created_by"`
	OwnerID          string     `json:"owner_id"`
	Title            string     `json:"title"`
	Status           string     `json:"status"`
	ScheduledAt      time.Time  `json:"scheduled_at"`
	ScheduledLocal   string     `json:"scheduled_local"`
	Timezone         string     `json:"timezone"`
	UTCOffsetSeconds int        `json:"utc_offset_seconds"`
	Resource         *Resource  `json:"resource"`
	IsDue            bool       `json:"is_due"`
	CompletedAt      *time.Time `json:"completed_at"`
	DismissedAt      *time.Time `json:"dismissed_at"`
	Revision         int64      `json:"revision"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}
type Record struct {
	Summary
	Description string `json:"description"`
}
type Mutation struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}
type Owner struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}
type Pagination struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"next_cursor"`
}
type Page[T any] struct {
	Data []T        `json:"data"`
	Page Pagination `json:"page"`
}
type Filter struct {
	Cursor string
	Limit  int
	Status string
	Due    string
	Owner  string
	Search string
	Sort   string
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validID(v string) bool {
	return uuidPattern.MatchString(v) && v != "00000000-0000-0000-0000-000000000000"
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
func validText(v string, max int, required, multiline bool) bool {
	if !utf8.ValidString(v) || utf8.RuneCountInString(v) > max || (required && v == "") {
		return false
	}
	for _, r := range v {
		if unicode.IsControl(r) && !(multiline && r == '\n') {
			return false
		}
	}
	return true
}
func validFilter(f Filter) bool {
	return (f.Cursor == "" || validID(f.Cursor)) && f.Limit >= 1 && f.Limit <= 100 &&
		(f.Status == "all" || f.Status == "pending" || f.Status == "completed" || f.Status == "dismissed") &&
		(f.Due == "all" || f.Due == "due" || f.Due == "upcoming") &&
		(f.Owner == "any" || f.Owner == "me" || validID(f.Owner)) &&
		validText(f.Search, 100, false, false) && (f.Sort == "id" || f.Sort == "-id")
}

type validatedProfile struct {
	Profile
	ScheduledAt time.Time `json:"scheduled_at"`
}

func normalize(p Profile) (validatedProfile, error) {
	p.Title = strings.TrimSpace(p.Title)
	p.Description = strings.TrimSpace(strings.ReplaceAll(p.Description, "\r\n", "\n"))
	p.OwnerID = strings.ToLower(p.OwnerID)
	if !validText(p.Title, 200, true, false) || !validText(p.Description, 8000, false, true) || !validID(p.OwnerID) {
		return validatedProfile{}, ErrInvalid
	}
	if p.Resource != nil {
		v := *p.Resource
		v.ID = strings.ToLower(v.ID)
		if !validID(v.ID) || (v.Kind != "task" && v.Kind != "plan" && v.Kind != "milestone") {
			return validatedProfile{}, ErrInvalid
		}
		p.Resource = &v
	}
	instant, local, err := timezone.Resolve(p.ScheduledLocal, p.Timezone, p.UTCOffsetSeconds)
	if err != nil {
		return validatedProfile{}, ErrSchedule
	}
	p.ScheduledLocal = local
	return validatedProfile{p, instant}, nil
}
