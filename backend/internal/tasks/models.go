// Package tasks owns client tasks and their audited state transitions.
package tasks

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
	ErrInvalid    = errors.New("invalid task input")
	ErrMissing    = errors.New("task unavailable")
	ErrConflict   = errors.New("task revision or archive conflict")
	ErrTransition = errors.New("invalid task transition")
	ErrAssignee   = errors.New("invalid task assignee")
)

type Profile struct {
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Priority    string     `json:"priority"`
	AssigneeID  *string    `json:"assignee_id"`
	StartAt     *time.Time `json:"start_at"`
	DueAt       *time.Time `json:"due_at"`
	Tags        []string   `json:"tags"`
}
type CreateInput struct {
	Profile
	Status string `json:"status"`
}
type Summary struct {
	ID          string     `json:"id"`
	ClientID    string     `json:"client_id"`
	CreatedBy   string     `json:"created_by"`
	AssigneeID  *string    `json:"assignee_id"`
	Title       string     `json:"title"`
	Status      string     `json:"status"`
	Priority    string     `json:"priority"`
	StartAt     *time.Time `json:"start_at"`
	DueAt       *time.Time `json:"due_at"`
	CompletedAt *time.Time `json:"completed_at"`
	CancelledAt *time.Time `json:"cancelled_at"`
	Revision    int64      `json:"revision"`
	Tags        []string   `json:"tags"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	ArchivedAt  *time.Time `json:"archived_at"`
}
type Task struct {
	Summary
	Description string `json:"description"`
}
type Mutation struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}
type Assignee struct {
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
	Cursor   string
	Limit    int
	Status   string
	Priority string
	Assignee string
	Search   string
	Tag      string
	Archived string
	Sort     string
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
func validStatus(s string) bool {
	switch s {
	case "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled":
		return true
	}
	return false
}
func validPriority(s string) bool {
	switch s {
	case "low", "medium", "high", "urgent":
		return true
	}
	return false
}
func validText(s string, max int, required, multiline bool) bool {
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > max || (required && s == "") {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) && !(multiline && r == '\n') {
			return false
		}
	}
	return true
}
func normalize(p Profile) (Profile, error) {
	p.Title = strings.TrimSpace(p.Title)
	p.Description = strings.TrimSpace(strings.ReplaceAll(p.Description, "\r\n", "\n"))
	if p.Priority == "" {
		p.Priority = "medium"
	}
	if !validText(p.Title, 200, true, false) || !validText(p.Description, 8000, false, true) || !validPriority(p.Priority) || len(p.Tags) > 20 {
		return Profile{}, ErrInvalid
	}
	if p.AssigneeID != nil {
		if !validID(*p.AssigneeID) {
			return Profile{}, ErrInvalid
		}
		id := strings.ToLower(*p.AssigneeID)
		p.AssigneeID = &id
	}
	if p.StartAt != nil {
		v := p.StartAt.UTC()
		p.StartAt = &v
	}
	if p.DueAt != nil {
		v := p.DueAt.UTC()
		p.DueAt = &v
	}
	for _, v := range []*time.Time{p.StartAt, p.DueAt} {
		if v != nil && (v.Year() < 1 || v.Year() > 9999) {
			return Profile{}, ErrInvalid
		}
	}
	if p.StartAt != nil && p.DueAt != nil && p.DueAt.Before(*p.StartAt) {
		return Profile{}, ErrInvalid
	}
	p.Tags = append([]string{}, p.Tags...)
	seen := map[string]bool{}
	for i, tag := range p.Tags {
		tag = strings.ToLower(strings.TrimSpace(tag))
		if !validText(tag, 40, true, false) || seen[tag] {
			return Profile{}, ErrInvalid
		}
		seen[tag] = true
		p.Tags[i] = tag
	}
	return p, nil
}
func validFilter(f Filter) bool {
	return (f.Cursor == "" || validID(f.Cursor)) && f.Limit >= 1 && f.Limit <= 100 &&
		(f.Status == "all" || validStatus(f.Status)) && (f.Priority == "all" || validPriority(f.Priority)) &&
		(f.Assignee == "" || f.Assignee == "unassigned" || validID(f.Assignee)) &&
		(f.Archived == "false" || f.Archived == "true" || f.Archived == "all") && (f.Sort == "id" || f.Sort == "-id") &&
		validText(f.Search, 100, false, false) && validText(f.Tag, 40, false, false)
}
