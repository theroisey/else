// Package activity projects authorized business events without exposing audit details.
package activity

import (
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
	"time"
)

var ErrInvalid = errors.New("invalid activity pagination")
var ErrMissing = errors.New("activity unavailable")

type Item struct {
	ID           string    `json:"id"`
	ClientID     string    `json:"client_id"`
	OccurredAt   time.Time `json:"occurred_at"`
	EventType    string    `json:"event_type"`
	ResourceKind string    `json:"resource_kind"`
	ResourceID   string    `json:"resource_id"`
	Summary      string    `json:"summary"`
}
type Pagination struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"next_cursor"`
}
type Page struct {
	Data []Item     `json:"data"`
	Page Pagination `json:"page"`
}
type Filter struct {
	Limit  int
	Cursor string
}
type boundary struct {
	Time time.Time
	ID   string
}

// Only server-owned labels are rendered; never concatenate audit/profile text.
var summaries = map[string]string{
	"client.created": "Client created.", "client.updated": "Client updated.", "client.archived": "Client archived.",
	"task.created": "Task created.", "task.updated": "Task updated.", "task.archived": "Task archived.", "task.completed": "Task completed.", "task.cancelled": "Task cancelled.",
	"plan.created": "Plan created.", "plan.updated": "Plan updated.", "plan.archived": "Plan archived.",
	"milestone.created": "Milestone created.", "milestone.updated": "Milestone updated.", "milestone.archived": "Milestone archived.",
	"reminder.created": "Reminder created.", "reminder.updated": "Reminder updated.", "reminder.completed": "Reminder completed.", "reminder.dismissed": "Reminder dismissed.",
}
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validID(v string) bool {
	return uuidPattern.MatchString(v) && v != "00000000-0000-0000-0000-000000000000"
}
func validTime(v time.Time) bool {
	return v.Year() >= 1 && v.Year() <= 9999 && v.Nanosecond()%1000 == 0
}
func encodeCursor(client string, item Item) string {
	return base64.RawURLEncoding.EncodeToString([]byte("v1|" + client + "|" + item.OccurredAt.UTC().Format(time.RFC3339Nano) + "|" + item.ID))
}
func decodeCursor(client, raw string) (*boundary, error) {
	if raw == "" {
		return nil, nil
	}
	if len(raw) > 256 {
		return nil, ErrInvalid
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != raw {
		return nil, ErrInvalid
	}
	parts := strings.Split(string(decoded), "|")
	if len(parts) != 4 || parts[0] != "v1" || parts[1] != strings.ToLower(client) || !validID(parts[3]) || parts[3] != strings.ToLower(parts[3]) {
		return nil, ErrInvalid
	}
	stamp, err := time.Parse(time.RFC3339Nano, parts[2])
	if err != nil || !validTime(stamp) || stamp.UTC().Format(time.RFC3339Nano) != parts[2] {
		return nil, ErrInvalid
	}
	return &boundary{stamp, parts[3]}, nil
}
