// Package auditreader exposes bounded, authorized projections of immutable audit history.
package auditreader

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
)

var ErrInvalid = errors.New("invalid audit read")
var ErrDenied = errors.New("audit access denied")
var ErrMissing = errors.New("audit record unavailable")
var errData = errors.New("invalid audit projection")

type Summary struct {
	ID            string    `json:"id"`
	SchemaVersion int       `json:"schema_version"`
	OccurredAt    time.Time `json:"occurred_at"`
	ActorKind     string    `json:"actor_kind"`
	ActorUserID   *string   `json:"actor_user_id"`
	EventType     string    `json:"event_type"`
	ResourceKind  string    `json:"resource_kind"`
	ResourceID    string    `json:"resource_id"`
	ClientID      *string   `json:"client_id"`
	RequestID     string    `json:"request_id"`
}
type Snapshot struct {
	Exists              *bool      `json:"exists,omitempty"`
	Revision            *string    `json:"revision,omitempty"`
	Status              *string    `json:"status,omitempty"`
	TaskStatus          *string    `json:"task_status,omitempty"`
	PlanningStatus      *string    `json:"planning_status,omitempty"`
	ReminderStatus      *string    `json:"reminder_status,omitempty"`
	ReminderScheduledAt *time.Time `json:"reminder_scheduled_at,omitempty"`
	ReminderTimezone    *string    `json:"reminder_timezone,omitempty"`
}
type Metadata struct {
	Source string `json:"source"`
}
type Detail struct {
	Summary
	Before   *Snapshot `json:"before_state"`
	After    *Snapshot `json:"after_state"`
	Metadata Metadata  `json:"metadata"`
}
type Pagination struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"next_cursor"`
}
type Page struct {
	Data []Summary  `json:"data"`
	Page Pagination `json:"page"`
}
type Filter struct {
	Limit                                                                        int
	Cursor                                                                       string
	ActorID, ActorKind, EventType, ClientID, ResourceKind, ResourceID, RequestID string
	From, To                                                                     *time.Time
}
type boundary struct {
	Time time.Time
	ID   string
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var kindPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
var requestPattern = regexp.MustCompile(`^[A-Z2-7]{26}$`)
var timestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$`)

func validID(v string) bool {
	return uuidPattern.MatchString(v) && v != "00000000-0000-0000-0000-000000000000"
}
func validTime(v time.Time) bool {
	return v.Year() >= 1 && v.Year() <= 9999 && v.Nanosecond()%1000 == 0
}
func validEvent(v string) bool {
	p := strings.Split(v, ".")
	if len(p) != 2 || !kindPattern.MatchString(p[0]) {
		return false
	}
	switch p[1] {
	case "created", "updated", "archived", "deleted":
		return true
	case "disabled":
		return p[0] == "user"
	case "permission_changed":
		return p[0] == "role"
	case "completed":
		return p[0] == "task" || p[0] == "reminder"
	case "cancelled":
		return p[0] == "task" || p[0] == "billing"
	case "payment_recorded":
		return p[0] == "billing"
	case "dismissed":
		return p[0] == "reminder"
	}
	return false
}
func normalize(scope string, f Filter) (Filter, error) {
	if scope != "" && !validID(scope) || f.Limit < 1 || f.Limit > 100 || len(f.Cursor) > 256 {
		return f, ErrInvalid
	}
	scope = strings.ToLower(scope)
	for _, id := range []string{f.ActorID, f.ClientID, f.ResourceID} {
		if id != "" && !validID(id) {
			return f, ErrInvalid
		}
	}
	f.ActorID = strings.ToLower(f.ActorID)
	f.ClientID = strings.ToLower(f.ClientID)
	f.ResourceID = strings.ToLower(f.ResourceID)
	if scope != "" {
		if f.ClientID != "" && f.ClientID != scope {
			return f, ErrInvalid
		}
		f.ClientID = scope
	}
	if f.ActorKind != "" && f.ActorKind != "user" && f.ActorKind != "system" ||
		f.EventType != "" && !validEvent(f.EventType) || f.ResourceKind != "" && !kindPattern.MatchString(f.ResourceKind) ||
		f.RequestID != "" && !requestPattern.MatchString(f.RequestID) {
		return f, ErrInvalid
	}
	for _, stamp := range []*time.Time{f.From, f.To} {
		if stamp != nil && !validTime(*stamp) {
			return f, ErrInvalid
		}
	}
	if f.From != nil {
		t := f.From.UTC()
		f.From = &t
	}
	if f.To != nil {
		t := f.To.UTC()
		f.To = &t
	}
	if f.From != nil && f.To != nil && !f.From.Before(*f.To) {
		return f, ErrInvalid
	}
	return f, nil
}
func fingerprint(scope string, f Filter) string {
	f.Limit = 0
	f.Cursor = ""
	raw, _ := json.Marshal(struct {
		Scope  string
		Filter Filter
	}{strings.ToLower(scope), f})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func encodeCursor(scope string, f Filter, item Summary) string {
	return base64.RawURLEncoding.EncodeToString([]byte("v1|" + fingerprint(scope, f) + "|" + item.OccurredAt.UTC().Format(time.RFC3339Nano) + "|" + item.ID))
}
func decodeCursor(scope string, f Filter) (*boundary, error) {
	if f.Cursor == "" {
		return nil, nil
	}
	if len(f.Cursor) > 256 {
		return nil, ErrInvalid
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(f.Cursor)
	if err != nil || base64.RawURLEncoding.EncodeToString(raw) != f.Cursor {
		return nil, ErrInvalid
	}
	p := strings.Split(string(raw), "|")
	if len(p) != 4 || p[0] != "v1" || p[1] != fingerprint(scope, f) || !validID(p[3]) || p[3] != strings.ToLower(p[3]) {
		return nil, ErrInvalid
	}
	t, err := time.Parse(time.RFC3339Nano, p[2])
	if err != nil || !validTime(t) || t.UTC().Format(time.RFC3339Nano) != p[2] {
		return nil, ErrInvalid
	}
	return &boundary{t, p[3]}, nil
}
func (s Summary) valid(scope string) bool {
	return validID(s.ID) && s.SchemaVersion == 1 && validTime(s.OccurredAt) &&
		validEvent(s.EventType) && strings.HasPrefix(s.EventType, s.ResourceKind+".") && validID(s.ResourceID) &&
		requestPattern.MatchString(s.RequestID) &&
		((s.ActorKind == "system" && s.ActorUserID == nil) || (s.ActorKind == "user" && s.ActorUserID != nil && validID(*s.ActorUserID))) &&
		(s.ClientID == nil || validID(*s.ClientID)) && (scope == "" || s.ClientID != nil && *s.ClientID == strings.ToLower(scope))
}
