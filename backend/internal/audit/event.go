// Package audit owns typed, secret-free event payloads and atomic mutations.
package audit

import (
	"encoding/json"
	"errors"
	"regexp"
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
	Exists   *bool   `json:"exists,omitempty"`
	Revision *int64  `json:"revision,omitempty"`
	Status   *string `json:"status,omitempty"`
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
	default:
		return nil, nil, nil, ErrInvalidEvent
	}
	switch e.Metadata.Source {
	case HTTP, Job, CLI:
	default:
		return nil, nil, nil, ErrInvalidEvent
	}
	for _, snapshot := range []*Snapshot{e.Before, e.After} {
		if snapshot != nil && snapshot.Status != nil && *snapshot.Status != "active" && *snapshot.Status != "disabled" {
			return nil, nil, nil, ErrInvalidEvent
		}
		if snapshot != nil && snapshot.Revision != nil && *snapshot.Revision < 0 {
			return nil, nil, nil, ErrInvalidEvent
		}
	}
	// These concrete types contain no custom marshalers or arbitrary input.
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
