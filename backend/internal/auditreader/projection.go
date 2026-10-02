package auditreader

import (
	"bytes"
	"encoding/json"
	"io"
	"strconv"
	"strings"

	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/timezone"
)

func strictJSON(raw []byte, value any, maximum int) error {
	if len(raw) > maximum {
		return errData
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil {
		return errData
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errData
	}
	return nil
}

// Storage and read allowlists are deliberately separate. Revisions are strings
// in this read DTO so JavaScript consumers retain the full int64 exactly.
func projectSnapshot(raw []byte, kind string) (*Snapshot, error) {
	var stored *audit.Snapshot
	if err := strictJSON(raw, &stored, 1024); err != nil {
		return nil, err
	}
	if stored == nil {
		return nil, nil
	}
	s := stored
	if s.Revision != nil && *s.Revision < 0 || s.Status != nil && *s.Status != "active" && *s.Status != "disabled" {
		return nil, errData
	}
	if s.TaskStatus != nil && (kind != "task" || !oneOf(*s.TaskStatus, "backlog todo in_progress blocked review done cancelled")) {
		return nil, errData
	}
	if s.PlanningStatus != nil && !((kind == "plan" && oneOf(*s.PlanningStatus, "draft active completed cancelled")) ||
		(kind == "milestone" && oneOf(*s.PlanningStatus, "planned in_progress completed cancelled"))) {
		return nil, errData
	}
	if s.ReminderStatus != nil || s.ReminderScheduledAt != nil || s.ReminderTimezone != nil {
		if kind != "reminder" || s.ReminderStatus != nil && !oneOf(*s.ReminderStatus, "pending completed dismissed") ||
			(s.ReminderScheduledAt == nil) != (s.ReminderTimezone == nil) {
			return nil, errData
		}
		if s.ReminderScheduledAt != nil {
			_, offset := s.ReminderScheduledAt.Zone()
			if !validTime(*s.ReminderScheduledAt) || offset != 0 || !timezone.ValidName(*s.ReminderTimezone) {
				return nil, errData
			}
			t := s.ReminderScheduledAt.UTC()
			s.ReminderScheduledAt = &t
		}
	}
	result := &Snapshot{Exists: s.Exists, Status: s.Status, TaskStatus: s.TaskStatus, PlanningStatus: s.PlanningStatus,
		ReminderStatus: s.ReminderStatus, ReminderScheduledAt: s.ReminderScheduledAt, ReminderTimezone: s.ReminderTimezone}
	if s.Revision != nil {
		r := strconv.FormatInt(*s.Revision, 10)
		result.Revision = &r
	}
	return result, nil
}
func oneOf(value, allowed string) bool {
	return strings.Contains(" "+allowed+" ", " "+value+" ") && value != "" && !strings.Contains(value, " ")
}
func projectMetadata(raw []byte) (Metadata, error) {
	var m Metadata
	if err := strictJSON(raw, &m, 256); err != nil {
		return m, err
	}
	if m.Source != "http" && m.Source != "job" && m.Source != "cli" {
		return m, errData
	}
	return m, nil
}
