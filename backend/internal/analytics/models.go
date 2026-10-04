// Package analytics owns authorized GA4 setup, durable jobs and measured reads.
package analytics

import (
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"time"

	"github.com/theroisey/else/backend/internal/integrations/connections"
	"github.com/theroisey/else/backend/internal/integrations/providers/ga4"
)

var ErrInvalid = errors.New("invalid analytics request")
var ErrMissing = errors.New("analytics unavailable for this client")
var ErrConflict = errors.New("analytics revision conflict")
var ErrUnavailable = errors.New("analytics unavailable")
var errNoWork = errors.New("no analytics work")

const maxWorkspaceBytes = 2 << 20

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var property = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)

func validID(id string) bool {
	return uuid.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
}
func newID() string {
	var bytes [16]byte
	_, _ = rand.Read(bytes[:])
	bytes[6], bytes[8] = bytes[6]&0x0f|0x40, bytes[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
}
func revision(raw string) (int64, error) {
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 || strconv.FormatInt(value, 10) != raw {
		return 0, ErrInvalid
	}
	return value, nil
}
func validPeriod(since, until string) bool {
	start, e1 := time.Parse(time.DateOnly, since)
	end, e2 := time.Parse(time.DateOnly, until)
	return e1 == nil && e2 == nil && start.Year() >= 2000 && start.Format(time.DateOnly) == since && end.Format(time.DateOnly) == until && !end.Before(start) && end.Sub(start) <= 30*24*time.Hour
}

type Queued struct {
	JobID              string `json:"job_id"`
	State              string `json:"state"`
	ConnectionRevision string `json:"connection_revision"`
}

type Status struct {
	JobID     *string    `json:"job_id"`
	State     string     `json:"state"`
	Reason    *string    `json:"reason"`
	UpdatedAt *time.Time `json:"updated_at"`
	SyncedAt  *time.Time `json:"synced_at"`
	Stale     bool       `json:"stale"`
}

type View struct {
	Status Status         `json:"status"`
	Data   *ga4.Workspace `json:"data"`
}

type ConnectionPage struct {
	Data   []connections.Connection `json:"data"`
	NextID *string                  `json:"next_id"`
}
