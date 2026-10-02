// Package planning owns client plans, milestones and historical task links.
package planning

import (
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	ErrInvalid    = errors.New("invalid planning input")
	ErrMissing    = errors.New("planning record unavailable")
	ErrConflict   = errors.New("planning revision or lifecycle conflict")
	ErrTransition = errors.New("invalid planning transition")
	ErrDates      = errors.New("invalid planning date window")
	ErrLink       = errors.New("invalid planning task link")
)

type Profile struct {
	Title       string     `json:"title"`
	Description string     `json:"description"`
	StartAt     *time.Time `json:"start_at"`
	DueAt       *time.Time `json:"due_at"`
}
type MilestoneProfile struct {
	Title       string     `json:"title"`
	Description string     `json:"description"`
	DueAt       *time.Time `json:"due_at"`
}

func (p MilestoneProfile) profile() Profile {
	return Profile{Title: p.Title, Description: p.Description, DueAt: p.DueAt}
}

type Summary struct {
	ID          string     `json:"id"`
	ClientID    string     `json:"client_id"`
	PlanID      string     `json:"plan_id,omitempty"`
	CreatedBy   string     `json:"created_by"`
	Title       string     `json:"title"`
	Status      string     `json:"status"`
	StartAt     *time.Time `json:"start_at"`
	DueAt       *time.Time `json:"due_at"`
	CompletedAt *time.Time `json:"completed_at"`
	CancelledAt *time.Time `json:"cancelled_at"`
	Revision    int64      `json:"revision"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	ArchivedAt  *time.Time `json:"archived_at"`
}
type Record struct {
	Summary
	Description string    `json:"description"`
	TaskIDs     *[]string `json:"task_ids,omitempty"`
}
type Mutation struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}
type Link struct {
	ID         string     `json:"id"`
	TaskID     string     `json:"task_id"`
	LinkedAt   time.Time  `json:"linked_at"`
	UnlinkedAt *time.Time `json:"unlinked_at"`
}
type Candidate struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
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
	Cursor   string
	Limit    int
	Status   string
	Search   string
	Archived string
	Sort     string
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
func validState(v string, milestone bool) bool {
	if v == "completed" || v == "cancelled" {
		return true
	}
	if milestone {
		return v == "planned" || v == "in_progress"
	}
	return v == "draft" || v == "active"
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
func normalize(p Profile, milestone bool) (Profile, error) {
	p.Title = strings.TrimSpace(p.Title)
	p.Description = strings.TrimSpace(strings.ReplaceAll(p.Description, "\r\n", "\n"))
	if !validText(p.Title, 200, true, false) || !validText(p.Description, 8000, false, true) || (milestone && p.StartAt != nil) {
		return Profile{}, ErrInvalid
	}
	for _, field := range []**time.Time{&p.StartAt, &p.DueAt} {
		if *field != nil {
			v := (*field).UTC().Truncate(time.Microsecond)
			if v.Year() < 1 || v.Year() > 9999 {
				return Profile{}, ErrInvalid
			}
			*field = &v
		}
	}
	if p.StartAt != nil && p.DueAt != nil && p.DueAt.Before(*p.StartAt) {
		return Profile{}, ErrDates
	}
	return p, nil
}
func normalizedLinks(ids []string) ([]string, error) {
	if len(ids) > 50 {
		return nil, ErrInvalid
	}
	result := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		id = strings.ToLower(id)
		if !validID(id) || seen[id] {
			return nil, ErrInvalid
		}
		seen[id] = true
		result = append(result, id)
	}
	return result, nil
}
func validFilter(f Filter, milestone bool) bool {
	return (f.Cursor == "" || validID(f.Cursor)) && f.Limit >= 1 && f.Limit <= 100 && (f.Status == "all" || validState(f.Status, milestone)) &&
		validText(f.Search, 100, false, false) && (f.Archived == "false" || f.Archived == "true" || f.Archived == "all") && (f.Sort == "id" || f.Sort == "-id")
}
