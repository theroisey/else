package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
	"github.com/theroisey/else/backend/internal/integrations/providerhttp"
	"github.com/theroisey/else/backend/internal/integrations/providers/ga4"
)

type Worker struct {
	service *Service
	adapter *ga4.Adapter
}

// One gate is shared across all fixed-origin provider clients. Database leases
// cap concurrent work across replicas; no background work runs inside the API.
func NewWorker(service *Service) (*Worker, error) {
	if service == nil || service.ring == nil || service.encryption == nil {
		return nil, ErrInvalid
	}
	adapter, err := ga4.NewAdapter(providerhttp.NewAdmission())
	if err != nil {
		return nil, ErrInvalid
	}
	return &Worker{service, adapter}, nil
}

type claimed struct {
	id, client, connection, actor, state string
	lease, account                       *string
	since, until                         time.Time
	envelope                             []byte
}

func (claimed) Format(state fmt.State, _ rune) { _, _ = state.Write([]byte("[private analytics job]")) }
func (claimed) MarshalJSON() ([]byte, error)   { return nil, ErrUnavailable }

func (s *Service) claim(ctx context.Context) (claimed, error) {
	var job claimed
	err := audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var before, after int64
		if err := q.QueryRow(ctx, `SELECT job_id::text,client_id::text,connection_id::text,requested_by::text,since,until,state,before_revision,revision,lease_token::text,property_account,envelope FROM app.analytics_sync_claim()`).
			Scan(&job.id, &job.client, &job.connection, &job.actor, &job.since, &job.until, &job.state, &before, &after, &job.lease, &job.account, &job.envelope); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return audit.Event{}, errNoWork
			}
			return audit.Event{}, err
		}
		if !validID(job.id) || !validID(job.client) || !validID(job.connection) || !validID(job.actor) || before < 1 || after != before+1 || !validPeriod(job.since.Format(time.DateOnly), job.until.Format(time.DateOnly)) {
			return audit.Event{}, ErrUnavailable
		}
		switch job.state {
		case "running":
			if job.lease == nil || !validID(*job.lease) || job.account == nil || !property.MatchString(*job.account) || len(job.envelope) == 0 || len(job.envelope) > credentials.MaxPlaintextBytes+1024 {
				return audit.Event{}, ErrUnavailable
			}
		case "failed":
			if job.lease != nil || job.account != nil || len(job.envelope) != 0 {
				return audit.Event{}, ErrUnavailable
			}
		default:
			return audit.Event{}, ErrUnavailable
		}
		return event(audit.Actor{Kind: audit.System}, audit.Job, "analytics_sync", job.id, job.client, before, after), nil
	})
	if err != nil {
		clear(job.envelope)
		if errors.Is(err, errNoWork) {
			return claimed{}, errNoWork
		}
		return claimed{}, safeError(err)
	}
	return job, nil
}

func (s *Service) fence(ctx context.Context, job claimed) error {
	if ctx == nil || ctx.Err() != nil || job.lease == nil {
		return ErrUnavailable
	}
	var allowed bool
	if err := s.pool.QueryRow(ctx, `SELECT app.analytics_job_allowed($1::uuid,$2::uuid)`, job.id, *job.lease).Scan(&allowed); err != nil || !allowed || ctx.Err() != nil {
		return ErrUnavailable
	}
	return nil
}

// Keep the shared lifecycle lock through bounded decryption/key parsing, so
// permission revocation cannot complete while a credential is being opened.
// Close this transaction before any provider network request.
func (s *Service) credential(ctx context.Context, job claimed) (*ga4.ServiceAccount, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, ErrUnavailable
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	var allowed bool
	if err := tx.QueryRow(ctx, `SELECT app.analytics_job_allowed($1::uuid,$2::uuid)`, job.id, *job.lease).Scan(&allowed); err != nil || !allowed || ctx.Err() != nil {
		return nil, ErrUnavailable
	}
	envelope, err := credentials.ParseEnvelope(job.envelope)
	if err != nil {
		return nil, ErrUnavailable
	}
	binding := credentials.Binding{ClientID: job.client, ConnectionID: job.connection, Provider: "ga4", Purpose: "provider_credential"}
	plaintext, err := s.ring.Open(binding, envelope)
	defer clear(plaintext)
	if err != nil || ctx.Err() != nil {
		return nil, ErrUnavailable
	}
	credential, err := ga4.ParseServiceAccount(plaintext)
	if err != nil || ctx.Err() != nil || tx.Commit(ctx) != nil {
		return nil, ErrUnavailable
	}
	return credential, nil
}

func (s *Service) finish(ctx context.Context, job claimed, workspace *ga4.Workspace) error {
	var raw []byte
	if workspace != nil {
		request := ga4.Request{ClientID: job.client, ConnectionID: job.connection, Since: job.since.Format(time.DateOnly), Until: job.until.Format(time.DateOnly)}
		if !ga4.ValidWorkspace(*workspace, request) {
			return ErrUnavailable
		}
		var err error
		raw, err = json.Marshal(workspace)
		if err != nil || len(raw) == 0 || len(raw) > maxWorkspaceBytes {
			return ErrUnavailable
		}
	}
	defer clear(raw)
	err := audit.WithTransactionEvents(ctx, s.pool, func(ctx context.Context, q audit.Queries) ([]audit.Event, error) {
		var id, client, connection, state string
		var snapshot *string
		var beforeJob, afterJob, beforeConnection, afterConnection, beforeSnapshot, afterSnapshot int64
		if err := q.QueryRow(ctx, `SELECT job_id::text,client_id::text,connection_id::text,state,before_job_revision,job_revision,before_connection_revision,connection_revision,snapshot_id::text,before_snapshot_revision,snapshot_revision FROM app.analytics_sync_finish($1::uuid,$2::uuid,$3::jsonb)`, job.id, *job.lease, raw).
			Scan(&id, &client, &connection, &state, &beforeJob, &afterJob, &beforeConnection, &afterConnection, &snapshot, &beforeSnapshot, &afterSnapshot); err != nil {
			return nil, err
		}
		if id != job.id || client != job.client || connection != job.connection || beforeJob < 1 || afterJob != beforeJob+1 {
			return nil, ErrUnavailable
		}
		system := audit.Actor{Kind: audit.System}
		events := []audit.Event{event(system, audit.Job, "analytics_sync", id, client, beforeJob, afterJob)}
		switch state {
		case "succeeded":
			if workspace == nil || snapshot == nil || !validID(*snapshot) || beforeSnapshot < 0 || afterSnapshot != beforeSnapshot+1 || beforeConnection < 1 || afterConnection != beforeConnection+1 {
				return nil, ErrUnavailable
			}
			events = append(events, event(system, audit.Job, "analytics_snapshot", *snapshot, client, beforeSnapshot, afterSnapshot), event(system, audit.Job, "integration_connection", connection, client, beforeConnection, afterConnection))
		case "failed":
			if snapshot != nil || beforeSnapshot != 0 || afterSnapshot != 0 || beforeConnection != afterConnection {
				return nil, ErrUnavailable
			}
		default:
			return nil, ErrUnavailable
		}
		return events, nil
	})
	return safeFinishError(err)
}

func safeFinishError(err error) error {
	if err == nil {
		return nil
	}
	return safeError(err)
}

// RunOnce claims/audits at most one job, then closes the transaction before key
// use or network work. Every provider request rechecks its durable fence. Process
// cancellation abandons the lease for bounded crash recovery; it cannot publish.
func (w *Worker) RunOnce(ctx context.Context) (bool, error) {
	if w == nil || w.service == nil || w.adapter == nil || ctx == nil || ctx.Err() != nil {
		return false, ErrInvalid
	}
	operation, cancel := context.WithTimeout(correlation.New(ctx), 150*time.Second)
	defer cancel()
	job, err := w.service.claim(operation)
	defer clear(job.envelope)
	if errors.Is(err, errNoWork) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if job.state == "failed" {
		return true, nil
	}
	var workspace *ga4.Workspace
	credential, err := w.service.credential(operation, job)
	if err == nil {
		request := ga4.Request{ClientID: job.client, ConnectionID: job.connection, PropertyID: *job.account, Since: job.since.Format(time.DateOnly), Until: job.until.Format(time.DateOnly)}
		result, err := w.adapter.FetchFenced(operation, credential, request, func(ctx context.Context) error { return w.service.fence(ctx, job) })
		if err == nil {
			workspace = &result
		}
	}
	if operation.Err() != nil {
		return true, ErrUnavailable
	}
	return true, w.service.finish(operation, job, workspace)
}

// Prune deletes at most 100 expired aggregate snapshots with mandatory safe
// events. Account/credential/budget/job/audit history is not removed.
func (s *Service) Prune(ctx context.Context) error {
	if ctx == nil || ctx.Err() != nil {
		return ErrInvalid
	}
	err := audit.WithTransactionEvents(correlation.New(ctx), s.pool, func(ctx context.Context, q audit.Queries) ([]audit.Event, error) {
		rows, err := q.Query(ctx, `SELECT id::text,client_id::text,revision FROM app.analytics_snapshots_prune(100)`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var events []audit.Event
		for rows.Next() {
			var id, client string
			var revision int64
			if rows.Scan(&id, &client, &revision) != nil || !validID(id) || !validID(client) || revision < 1 {
				return nil, ErrUnavailable
			}
			events = append(events, event(audit.Actor{Kind: audit.System}, audit.Job, "analytics_snapshot", id, client, revision, 0))
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(events) == 0 {
			return nil, errNoWork
		}
		return events, nil
	})
	if errors.Is(err, errNoWork) {
		return nil
	}
	return safeFinishError(err)
}
