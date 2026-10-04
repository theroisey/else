package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/budget"
	"github.com/theroisey/else/backend/internal/integrations/connections"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
	"github.com/theroisey/else/backend/internal/integrations/providers/ga4"
	"github.com/theroisey/else/backend/internal/integrations/vault"
)

type Service struct {
	pool       *pgxpool.Pool
	ring       *credentials.Keyring
	encryption *budget.Service
}

// Reads remain available without protected encryption keys. Setup fails closed
// after authorization when no ring is configured; no provider call occurs here.
func NewService(pool *pgxpool.Pool, ring *credentials.Keyring) (*Service, error) {
	if pool == nil {
		return nil, ErrInvalid
	}
	s := &Service{pool: pool, ring: ring}
	if ring != nil {
		var err error
		s.encryption, err = budget.NewService(pool, ring)
		if err != nil {
			return nil, ErrInvalid
		}
	}
	return s, nil
}

func safeError(err error) error {
	switch {
	case errors.Is(err, ErrInvalid), errors.Is(err, budget.ErrInvalid):
		return ErrInvalid
	case errors.Is(err, ErrMissing), errors.Is(err, pgx.ErrNoRows), errors.Is(err, budget.ErrMissing):
		return ErrMissing
	case errors.Is(err, ErrConflict):
		return ErrConflict
	}
	var postgres *pgconn.PgError
	if errors.As(err, &postgres) {
		switch postgres.Code {
		case "P0002":
			return ErrMissing
		case "P0003", "23505":
			return ErrConflict
		case "22023":
			return ErrInvalid
		}
	}
	return ErrUnavailable
}

func validMutation(ctx context.Context, actor, client, connection string) bool {
	return ctx != nil && ctx.Err() == nil && correlation.ID(ctx) != "" && validID(actor) && validID(client) && validID(connection)
}

func event(actor audit.Actor, source audit.Source, kind, id, client string, before, after int64) audit.Event {
	prior, next := before > 0, after > 0
	result := audit.Event{Actor: actor, Metadata: audit.Metadata{Source: source}, ResourceKind: kind, ResourceID: id, ClientID: client,
		Action: audit.Updated, Before: &audit.Snapshot{Exists: &prior}, After: &audit.Snapshot{Exists: &next}}
	if before == 0 {
		result.Action = audit.Created
	} else {
		result.Before.Revision = &before
	}
	if after == 0 {
		result.Action = audit.Deleted
	} else {
		result.After.Revision = &after
	}
	return result
}

// Create allocates pending metadata only, with no credential/provider work. It
// returns the same safe projection as existing connection reads. Account IDs are
// immutable/private, globally unique, and never included in audit snapshots.
func (s *Service) Create(ctx context.Context, actor, client, account string) (connections.Connection, error) {
	id := newID()
	if !validMutation(ctx, actor, client, id) || !property.MatchString(account) {
		return connections.Connection{}, ErrInvalid
	}
	var result connections.Connection
	err := audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var number int64
		err := q.QueryRow(ctx, `SELECT id::text,client_id::text,provider,state,revision,created_at,updated_at FROM app.ga4_connection_create($1::uuid,$2::uuid,$3::uuid,$4)`, actor, client, id, account).
			Scan(&result.ID, &result.ClientID, &result.Provider, &result.State, &number, &result.CreatedAt, &result.UpdatedAt)
		if err != nil {
			return audit.Event{}, err
		}
		if result.ID != id || result.ClientID != client || result.Provider != "ga4" || result.State != "pending" || number != 1 {
			return audit.Event{}, ErrUnavailable
		}
		result.Revision = "1"
		result.CreatedAt, result.UpdatedAt = result.CreatedAt.UTC(), result.UpdatedAt.UTC()
		return event(audit.Actor{Kind: audit.User, UserID: actor}, audit.HTTP, "integration_connection", id, client, 0, 1), nil
	})
	if err != nil {
		return connections.Connection{}, safeError(err)
	}
	return result, nil
}

func (s *Service) checkpoint(ctx context.Context, actor, client, connection string) (vault.Checkpoint, error) {
	var result vault.Checkpoint
	var generation int64
	var provider string
	var bindingRevision, bindingGeneration int64
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT r.connection_revision,r.connection_generation,r.credential_revision,r.credential_generation,r.envelope,b.provider,b.revision,b.generation FROM app.integration_credential_read($1::uuid,$2::uuid,$3::uuid) r CROSS JOIN app.integration_encryption_binding($1::uuid,$2::uuid,$3::uuid) b`, actor, client, connection).
		Scan(&result.ConnectionRevision, &result.Generation, &result.CredentialRevision, &generation, &raw, &provider, &bindingRevision, &bindingGeneration)
	clear(raw)
	if err != nil {
		return vault.Checkpoint{}, safeError(err)
	}
	if provider != "ga4" {
		return vault.Checkpoint{}, ErrMissing
	}
	if result.ConnectionRevision < 1 || result.Generation < 1 || result.CredentialRevision < 0 || bindingRevision != result.ConnectionRevision || bindingGeneration != result.Generation || (result.CredentialRevision > 0 && generation != result.Generation) {
		return vault.Checkpoint{}, ErrUnavailable
	}
	return result, nil
}

// Setup validates/encrypts locally and atomically writes the new credential,
// pending state and queued work. The independently committed encryption unit
// remains burned on failure. Callers own and clear plaintext bytes; no provider
// work runs in this HTTP operation. Replacement cancels and audits older jobs.
func (s *Service) Setup(ctx context.Context, actor, client, connection, expected, since, until string, plaintext []byte) (Queued, error) {
	number, err := revision(expected)
	if err != nil || !validMutation(ctx, actor, client, connection) || !validPeriod(since, until) || len(plaintext) == 0 || len(plaintext) > credentials.MaxPlaintextBytes {
		return Queued{}, ErrInvalid
	}
	current, err := s.checkpoint(ctx, actor, client, connection)
	if err != nil {
		return Queued{}, err
	}
	if current.ConnectionRevision != number || current.ConnectionRevision >= math.MaxInt64-1 || current.Generation == math.MaxInt64 || current.CredentialRevision == math.MaxInt64 {
		return Queued{}, ErrConflict
	}
	if s.encryption == nil {
		return Queued{}, ErrUnavailable
	}
	if _, err := ga4.ParseServiceAccount(plaintext); err != nil {
		return Queued{}, ErrInvalid
	}
	sealed, err := s.encryption.SealForSetup(ctx, actor, client, connection, plaintext)
	if err != nil {
		return Queued{}, safeError(err)
	}
	if sealed.Revision != current.ConnectionRevision || sealed.Generation != current.Generation {
		return Queued{}, ErrConflict
	}
	label, digest, err := s.ring.ActiveKeyIdentity()
	if err != nil {
		return Queued{}, ErrUnavailable
	}
	raw := sealed.Envelope.Binary()
	defer clear(raw)
	job := newID()
	var result Queued
	err = audit.WithTransactionEvents(ctx, s.pool, func(ctx context.Context, q audit.Queries) ([]audit.Event, error) {
		if _, err := q.Exec(ctx, `SELECT app.analytics_writer_lock()`); err != nil {
			return nil, err
		}
		var next vault.Checkpoint
		if err := q.QueryRow(ctx, `SELECT connection_revision,connection_generation,credential_revision FROM app.integration_credential_write($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,false)`, actor, client, connection, current.ConnectionRevision, current.Generation, current.CredentialRevision, label, digest[:], raw).
			Scan(&next.ConnectionRevision, &next.Generation, &next.CredentialRevision); err != nil {
			return nil, err
		}
		if next.ConnectionRevision != current.ConnectionRevision+1 || next.Generation != current.Generation+1 || next.CredentialRevision != current.CredentialRevision+1 {
			return nil, ErrUnavailable
		}
		user := audit.Actor{Kind: audit.User, UserID: actor}
		events := []audit.Event{event(user, audit.HTTP, "integration_credential", connection, client, current.CredentialRevision, next.CredentialRevision)}
		canceled, err := q.Query(ctx, `SELECT id::text,before_revision,after_revision FROM app.analytics_sync_cancel($1::uuid,$2::uuid,$3::uuid)`, actor, client, connection)
		if err != nil {
			return nil, err
		}
		for canceled.Next() {
			var id string
			var before, after int64
			if err := canceled.Scan(&id, &before, &after); err != nil || !validID(id) || before < 1 || after != before+1 {
				canceled.Close()
				return nil, ErrUnavailable
			}
			events = append(events, event(user, audit.HTTP, "analytics_sync", id, client, before, after))
		}
		canceled.Close()
		if err := canceled.Err(); err != nil {
			return nil, err
		}
		var id string
		var connectionRevision, jobRevision int64
		if err := q.QueryRow(ctx, `SELECT job_id::text,connection_revision,job_revision FROM app.analytics_sync_enqueue($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::date,$8::date,$9::uuid,true)`, actor, client, connection, next.ConnectionRevision, next.Generation, next.CredentialRevision, since, until, job).
			Scan(&id, &connectionRevision, &jobRevision); err != nil {
			return nil, err
		}
		if id != job || connectionRevision != current.ConnectionRevision+2 || jobRevision != 1 {
			return nil, ErrUnavailable
		}
		result = Queued{JobID: job, State: "queued", ConnectionRevision: strconv.FormatInt(connectionRevision, 10)}
		events = append(events, event(user, audit.HTTP, "integration_connection", connection, client, current.ConnectionRevision, connectionRevision), event(user, audit.HTTP, "analytics_sync", job, client, 0, 1))
		return events, nil
	})
	if err != nil {
		return Queued{}, safeError(err)
	}
	return result, nil
}

func (s *Service) Enqueue(ctx context.Context, actor, client, connection, expected, since, until string) (Queued, error) {
	number, err := revision(expected)
	if err != nil || !validMutation(ctx, actor, client, connection) || !validPeriod(since, until) {
		return Queued{}, ErrInvalid
	}
	current, err := s.checkpoint(ctx, actor, client, connection)
	if err != nil {
		return Queued{}, err
	}
	if current.ConnectionRevision != number || current.CredentialRevision == 0 {
		return Queued{}, ErrConflict
	}
	job := newID()
	var result Queued
	err = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var id string
		var connectionRevision, jobRevision int64
		if err := q.QueryRow(ctx, `SELECT job_id::text,connection_revision,job_revision FROM app.analytics_sync_enqueue($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::date,$8::date,$9::uuid,false)`, actor, client, connection, current.ConnectionRevision, current.Generation, current.CredentialRevision, since, until, job).
			Scan(&id, &connectionRevision, &jobRevision); err != nil {
			return audit.Event{}, err
		}
		if id != job || connectionRevision != number || jobRevision != 1 {
			return audit.Event{}, ErrUnavailable
		}
		result = Queued{JobID: job, State: "queued", ConnectionRevision: expected}
		return event(audit.Actor{Kind: audit.User, UserID: actor}, audit.HTTP, "analytics_sync", job, client, 0, 1), nil
	})
	if err != nil {
		return Queued{}, safeError(err)
	}
	return result, nil
}

func (s *Service) Read(ctx context.Context, actor, client, connection, since, until string) (View, error) {
	if ctx == nil || ctx.Err() != nil || !validID(actor) || !validID(client) || !validID(connection) || !validPeriod(since, until) {
		return View{}, ErrInvalid
	}
	result := View{Status: Status{State: "not_synced", Stale: true}}
	var state *string
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT job_id::text,job_state,reason,job_updated_at,last_synced_at,workspace FROM app.analytics_workspace_read($1::uuid,$2::uuid,$3::uuid,$4::date,$5::date)`, actor, client, connection, since, until).
		Scan(&result.Status.JobID, &state, &result.Status.Reason, &result.Status.UpdatedAt, &result.Status.SyncedAt, &raw)
	defer clear(raw)
	if err != nil {
		return View{}, safeError(err)
	}
	if state != nil {
		if result.Status.JobID == nil || !validID(*result.Status.JobID) || result.Status.UpdatedAt == nil {
			return View{}, ErrUnavailable
		}
		switch *state {
		case "queued", "running", "succeeded", "failed":
			result.Status.State = *state
		default:
			return View{}, ErrUnavailable
		}
	}
	if result.Status.Reason != nil {
		switch *result.Status.Reason {
		case "provider_unavailable", "authorization_required", "connection_changed", "interrupted":
		default:
			return View{}, ErrUnavailable
		}
	}
	if len(raw) > 0 {
		var workspace ga4.Workspace
		request := ga4.Request{ClientID: client, ConnectionID: connection, Since: since, Until: until}
		if len(raw) > maxWorkspaceBytes || result.Status.SyncedAt == nil || json.Unmarshal(raw, &workspace) != nil || !ga4.ValidWorkspace(workspace, request) {
			return View{}, ErrUnavailable
		}
		result.Data = &workspace
		result.Status.Stale = time.Since(*result.Status.SyncedAt) >= 24*time.Hour
	}
	for _, stamp := range []*time.Time{result.Status.UpdatedAt, result.Status.SyncedAt} {
		if stamp != nil {
			*stamp = stamp.UTC()
		}
	}
	return result, nil
}

func (s *Service) List(ctx context.Context, actor, client, after string) (ConnectionPage, error) {
	if ctx == nil || ctx.Err() != nil || !validID(actor) || !validID(client) || (after != "" && !validID(after)) {
		return ConnectionPage{}, ErrInvalid
	}
	var cursor any
	if after != "" {
		cursor = after
	}
	rows, err := s.pool.Query(ctx, `SELECT id::text,client_id::text,provider,state,revision::text,created_at,updated_at FROM app.analytics_connection_list($1::uuid,$2::uuid,$3::uuid,26)`, actor, client, cursor)
	if err != nil {
		return ConnectionPage{}, safeError(err)
	}
	defer rows.Close()
	result := ConnectionPage{Data: []connections.Connection{}}
	previous := after
	for rows.Next() {
		var record connections.Connection
		if rows.Scan(&record.ID, &record.ClientID, &record.Provider, &record.State, &record.Revision, &record.CreatedAt, &record.UpdatedAt) != nil || !validID(record.ID) || record.ID <= previous || record.ClientID != client || record.Provider != "ga4" {
			return ConnectionPage{}, ErrUnavailable
		}
		if _, err := revision(record.Revision); err != nil || record.UpdatedAt.Before(record.CreatedAt) {
			return ConnectionPage{}, ErrUnavailable
		}
		switch record.State {
		case "pending", "connected", "disconnect_pending", "revocation_failed", "disconnected", "reauthorization_required":
		default:
			return ConnectionPage{}, ErrUnavailable
		}
		if len(result.Data) == 25 {
			result.NextID = &previous
			break
		}
		record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
		result.Data = append(result.Data, record)
		previous = record.ID
	}
	if err := rows.Err(); err != nil {
		return ConnectionPage{}, safeError(err)
	}
	return result, nil
}
