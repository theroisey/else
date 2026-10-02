// Package overview provides bounded attention projections of authorized domains.
package overview

import (
	"errors"
	"regexp"
	"time"

	"github.com/theroisey/else/backend/internal/activity"
	"github.com/theroisey/else/backend/internal/billing"
)

var ErrInvalid = errors.New("invalid overview request")
var ErrMissing = errors.New("overview unavailable")

const QueueLimit = 5

type Queue[T any] struct {
	Items   []T  `json:"items"`
	HasMore bool `json:"has_more"`
}
type Client struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Status     string     `json:"status"`
	ArchivedAt *time.Time `json:"archived_at"`
}
type Task struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Status   string    `json:"status"`
	Priority string    `json:"priority"`
	DueAt    time.Time `json:"due_at"`
}
type Reminder struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	ScheduledAt time.Time `json:"scheduled_at"`
	Timezone    string    `json:"timezone"`
}
type Tasks struct {
	Overdue Queue[Task] `json:"overdue"`
	DueSoon Queue[Task] `json:"due_soon"`
}
type Reminders struct {
	Due      Queue[Reminder] `json:"due"`
	Upcoming Queue[Reminder] `json:"upcoming"`
}
type Finance struct {
	Currencies []billing.Totals `json:"currencies"`
}
type Overview struct {
	Client     Client                `json:"client"`
	AsOf       time.Time             `json:"as_of"`
	HorizonEnd time.Time             `json:"horizon_end"`
	Finance    *Finance              `json:"finance,omitempty"`
	Tasks      *Tasks                `json:"tasks,omitempty"`
	Reminders  *Reminders            `json:"reminders,omitempty"`
	Activity   *Queue[activity.Item] `json:"activity,omitempty"`
}

var idPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validID(v string) bool {
	return idPattern.MatchString(v) && v != "00000000-0000-0000-0000-000000000000"
}
