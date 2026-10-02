// Package audit owns typed, secret-free event payloads and atomic mutations.
package audit

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"time"

	"github.com/theroisey/else/backend/internal/timezone"
)

var ErrInvalidEvent = errors.New("invalid audit event")
var ErrMissingCorrelation = errors.New("audit correlation required")

type ActorKind string

const (
	System ActorKind = "system"
	User   ActorKind = "user"
)

// Actor is supplied by trusted application code, never decoded from a request.
// User actors require an authenticated adapter (introduced by the identity slice).
type Actor struct {
	Kind   ActorKind
	UserID string
}

type Action string

const (
	Created           Action = "created"
	Updated           Action = "updated"
	Archived          Action = "archived"
	Deleted           Action = "deleted"
	Disabled          Action = "disabled"
	PermissionChanged Action = "permission_changed"
	Completed         Action = "completed"
	Cancelled         Action = "cancelled"
	Dismissed         Action = "dismissed"
	PaymentRecorded   Action = "payment_recorded"
)

type Source string

const (
	HTTP Source = "http"
	Job  Source = "job"
	CLI  Source = "cli"
)

// Snapshot's initial allowlist contains universal record markers only. Domain
// slices must add reviewed typed fields; raw DTOs/maps/strings cannot be stored.
type Snapshot struct {
	Exists              *bool      `json:"exists,omitempty"`
	Revision            *int64     `json:"revision,omitempty"`
	Status              *string    `json:"status,omitempty"`
	TaskStatus          *string    `json:"task_status,omitempty"`
	PlanningStatus      *string    `json:"planning_status,omitempty"`
	ReminderStatus      *string    `json:"reminder_status,omitempty"`
	ReminderScheduledAt *time.Time `json:"reminder_scheduled_at,omitempty"`
	ReminderTimezone    *string    `json:"reminder_timezone,omitempty"`
	BillingStatus       *string    `json:"billing_status,omitempty"`
	Currency            *string    `json:"currency,omitempty"`
	AmountMinor         *string    `json:"amount_minor,omitempty"`
	PaidMinor           *string    `json:"paid_minor,omitempty"`
}

type Metadata struct {
	Source Source `json:"source"`
}

type Event struct {
	Actor  Actor
	Action Action
	// ResourceKind is a server-owned code constant, not a user-provided value.
	ResourceKind string
	ResourceID   string
	ClientID     string
	Before       *Snapshot
	After        *Snapshot
	Metadata     Metadata
}

var kindPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validUUID(id string) bool {
	return uuidPattern.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
}

func (e Event) encode() (before, after, metadata []byte, err error) {
	if !kindPattern.MatchString(e.ResourceKind) || !validUUID(e.ResourceID) ||
		(e.ClientID != "" && !validUUID(e.ClientID)) {
		return nil, nil, nil, ErrInvalidEvent
	}
	if (e.Actor.Kind != System && e.Actor.Kind != User) ||
		(e.Actor.Kind == System && e.Actor.UserID != "") ||
		(e.Actor.Kind == User && !validUUID(e.Actor.UserID)) {
		return nil, nil, nil, ErrInvalidEvent
	}
	switch e.Action {
	case Created, Updated, Archived, Deleted:
	case Disabled:
		if e.ResourceKind != "user" {
			return nil, nil, nil, ErrInvalidEvent
		}
	case PermissionChanged:
		if e.ResourceKind != "role" {
			return nil, nil, nil, ErrInvalidEvent
		}
	case Completed:
		if e.ResourceKind != "task" && e.ResourceKind != "reminder" {
			return nil, nil, nil, ErrInvalidEvent
		}
	case Cancelled:
		if e.ResourceKind != "task" && e.ResourceKind != "billing" {
			return nil, nil, nil, ErrInvalidEvent
		}
	case PaymentRecorded:
		if e.ResourceKind != "billing" {
			return nil, nil, nil, ErrInvalidEvent
		}
	case Dismissed:
		if e.ResourceKind != "reminder" {
			return nil, nil, nil, ErrInvalidEvent
		}
	default:
		return nil, nil, nil, ErrInvalidEvent
	}
	if e.ResourceKind == "reminder" && e.Action != Created && e.Action != Updated && e.Action != Completed && e.Action != Dismissed {
		return nil, nil, nil, ErrInvalidEvent
	}
	if e.ResourceKind == "billing" && e.Action != Created && e.Action != Updated && e.Action != PaymentRecorded && e.Action != Cancelled {
		return nil, nil, nil, ErrInvalidEvent
	}
	switch e.Metadata.Source {
	case HTTP, Job, CLI:
	default:
		return nil, nil, nil, ErrInvalidEvent
	}
	for _, snapshot := range []*Snapshot{e.Before, e.After} {
		if snapshot != nil && (snapshot.BillingStatus != nil || snapshot.Currency != nil || snapshot.AmountMinor != nil || snapshot.PaidMinor != nil) {
			if e.ResourceKind != "billing" || snapshot.BillingStatus == nil || snapshot.Currency == nil || snapshot.AmountMinor == nil || snapshot.PaidMinor == nil {
				return nil, nil, nil, ErrInvalidEvent
			}
			switch *snapshot.BillingStatus {
			case "pending", "partially_paid", "paid", "overdue", "cancelled":
			default:
				return nil, nil, nil, ErrInvalidEvent
			}
			switch *snapshot.Currency {
			case "USD", "EUR", "GBP", "TRY", "JPY", "KWD":
			default:
				return nil, nil, nil, ErrInvalidEvent
			}
			total, te := strconv.ParseInt(*snapshot.AmountMinor, 10, 64)
			paid, pe := strconv.ParseInt(*snapshot.PaidMinor, 10, 64)
			if te != nil || pe != nil || total <= 0 || paid < 0 || paid > total || strconv.FormatInt(total, 10) != *snapshot.AmountMinor || strconv.FormatInt(paid, 10) != *snapshot.PaidMinor {
				return nil, nil, nil, ErrInvalidEvent
			}
		}
		if snapshot != nil && (snapshot.ReminderStatus != nil || snapshot.ReminderScheduledAt != nil || snapshot.ReminderTimezone != nil) {
			if e.ResourceKind != "reminder" {
				return nil, nil, nil, ErrInvalidEvent
			}
			if snapshot.ReminderStatus != nil && *snapshot.ReminderStatus != "pending" && *snapshot.ReminderStatus != "completed" && *snapshot.ReminderStatus != "dismissed" {
				return nil, nil, nil, ErrInvalidEvent
			}
			if (snapshot.ReminderScheduledAt == nil) != (snapshot.ReminderTimezone == nil) {
				return nil, nil, nil, ErrInvalidEvent
			}
			if snapshot.ReminderScheduledAt != nil {
				stamp := *snapshot.ReminderScheduledAt
				_, offset := stamp.Zone()
				if stamp.Year() < 1 || stamp.Year() > 9999 || offset != 0 || stamp.Nanosecond()%1000 != 0 || !timezone.ValidName(*snapshot.ReminderTimezone) {
					return nil, nil, nil, ErrInvalidEvent
				}
			}
		}
		if snapshot != nil && snapshot.PlanningStatus != nil {
			state := *snapshot.PlanningStatus
			if e.ResourceKind == "plan" {
				if state != "draft" && state != "active" && state != "completed" && state != "cancelled" {
					return nil, nil, nil, ErrInvalidEvent
				}
			} else if e.ResourceKind == "milestone" {
				if state != "planned" && state != "in_progress" && state != "completed" && state != "cancelled" {
					return nil, nil, nil, ErrInvalidEvent
				}
			} else {
				return nil, nil, nil, ErrInvalidEvent
			}
		}
		if snapshot != nil && snapshot.TaskStatus != nil {
			if e.ResourceKind != "task" {
				return nil, nil, nil, ErrInvalidEvent
			}
			switch *snapshot.TaskStatus {
			case "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled":
			default:
				return nil, nil, nil, ErrInvalidEvent
			}
		}
		if snapshot != nil && snapshot.Status != nil && *snapshot.Status != "active" && *snapshot.Status != "disabled" {
			return nil, nil, nil, ErrInvalidEvent
		}
		if snapshot != nil && snapshot.Revision != nil && *snapshot.Revision < 0 {
			return nil, nil, nil, ErrInvalidEvent
		}
	}
	// These reviewed, typed fields exclude arbitrary DTOs and free-form input.
	before, err = json.Marshal(e.Before)
	if err != nil {
		return nil, nil, nil, ErrInvalidEvent
	}
	after, err = json.Marshal(e.After)
	if err != nil {
		return nil, nil, nil, ErrInvalidEvent
	}
	metadata, err = json.Marshal(e.Metadata)
	if err != nil || len(before) > 1024 || len(after) > 1024 || len(metadata) > 256 {
		return nil, nil, nil, ErrInvalidEvent
	}
	return before, after, metadata, nil
}
