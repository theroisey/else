package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
	"github.com/theroisey/else/backend/internal/integrations/providerhttp"
	"github.com/theroisey/else/backend/internal/integrations/providers/ga4"
	"github.com/theroisey/else/backend/internal/integrations/providers/woocommerce"
)

type Worker struct {
	service   *Service
	adapter   *ga4.Adapter
	admission *providerhttp.Admission
	cycles    atomic.Uint64
}

// One gate is shared across all fixed-origin provider clients. Database leases
// cap concurrent work across replicas; no background work runs inside the API.
func NewWorker(service *Service) (*Worker, error) {
	if service == nil || service.ring == nil || service.encryption == nil {
		return nil, ErrInvalid
	}
	admission := providerhttp.NewAdmission()
	adapter, err := ga4.NewAdapter(admission)
	if err != nil {
		return nil, ErrInvalid
	}
	return &Worker{service: service, adapter: adapter, admission: admission}, nil
}

type claimed struct {
	id, client, connection, actor, state, provider string
	lease, account                                 *string
	since, until, start, end                       *time.Time
	currency                                       *string
	envelope                                       []byte
}

func (claimed) Format(state fmt.State, _ rune) { _, _ = state.Write([]byte("[private analytics job]")) }
func (claimed) MarshalJSON() ([]byte, error)   { return nil, ErrUnavailable }

func (job claimed) period() syncPeriod {
	result := syncPeriod{provider: job.provider}
	if job.since != nil {
		result.since = job.since.Format(time.DateOnly)
	}
	if job.until != nil {
		result.until = job.until.Format(time.DateOnly)
	}
	if job.start != nil {
		result.start = job.start.UTC().Format(time.RFC3339)
	}
	if job.end != nil {
		result.end = job.end.UTC().Format(time.RFC3339)
	}
	if job.currency != nil {
		result.currency = *job.currency
	}
	return result
}

func (s *Service) claim(ctx context.Context, provider string) (claimed, error) {
	var job claimed
	err := audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var before, after int64
		if err := q.QueryRow(ctx, `SELECT job_id::text,client_id::text,connection_id::text,requested_by::text,since,until,provider,start_at,end_at,currency,state,before_revision,revision,lease_token::text,property_account,envelope FROM app.provider_sync_claim($1)`, provider).
			Scan(&job.id, &job.client, &job.connection, &job.actor, &job.since, &job.until, &job.provider, &job.start, &job.end, &job.currency, &job.state, &before, &after, &job.lease, &job.account, &job.envelope); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return audit.Event{}, errNoWork
			}
			return audit.Event{}, err
		}
		if !validID(job.id) || !validID(job.client) || !validID(job.connection) || !validID(job.actor) || before < 1 || after != before+1 || job.provider != provider || !job.period().valid(job.client, job.connection) {
			return audit.Event{}, ErrUnavailable
		}
		switch job.state {
		case "running":
			if job.lease == nil || !validID(*job.lease) || job.account == nil || (provider == "ga4" && !property.MatchString(*job.account)) || (provider == "woocommerce" && !providerhttp.ValidOrigin(*job.account)) || len(job.envelope) == 0 || len(job.envelope) > credentials.MaxPlaintextBytes+1024 {
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
type providerCredential struct {
	analytics *ga4.ServiceAccount
	commerce  *woocommerce.ReadKey
}

func (providerCredential) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte("[private provider credential]"))
}
func (providerCredential) MarshalJSON() ([]byte, error) { return nil, ErrUnavailable }

func (s *Service) credential(ctx context.Context, job claimed) (providerCredential, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return providerCredential{}, ErrUnavailable
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	var allowed bool
	if err := tx.QueryRow(ctx, `SELECT app.analytics_job_allowed($1::uuid,$2::uuid)`, job.id, *job.lease).Scan(&allowed); err != nil || !allowed || ctx.Err() != nil {
		return providerCredential{}, ErrUnavailable
	}
	envelope, err := credentials.ParseEnvelope(job.envelope)
	if err != nil {
		return providerCredential{}, ErrUnavailable
	}
	binding := credentials.Binding{ClientID: job.client, ConnectionID: job.connection, Provider: job.provider, Purpose: "provider_credential"}
	plaintext, err := s.ring.Open(binding, envelope)
	defer clear(plaintext)
	if err != nil || ctx.Err() != nil {
		return providerCredential{}, ErrUnavailable
	}
	var credential providerCredential
	switch job.provider {
	case "ga4":
		credential.analytics, err = ga4.ParseServiceAccount(plaintext)
	case "woocommerce":
		credential.commerce, err = woocommerce.ParseReadKey(plaintext)
	default:
		return providerCredential{}, ErrUnavailable
	}
	if err != nil || ctx.Err() != nil || tx.Commit(ctx) != nil {
		return providerCredential{}, ErrUnavailable
	}
	return credential, nil
}

func (s *Service) finish(ctx context.Context, job claimed, workspace any) error {
	var raw []byte
	if workspace != nil {
		valid := false
		switch job.provider {
		case "ga4":
			value, ok := workspace.(*ga4.Workspace)
			request := ga4.Request{ClientID: job.client, ConnectionID: job.connection, Since: job.period().since, Until: job.period().until}
			valid = ok && value != nil && ga4.ValidWorkspace(*value, request)
		case "woocommerce":
			value, ok := workspace.(*woocommerce.Workspace)
			valid = ok && value != nil && woocommerce.ValidWorkspace(*value, job.period().expectation(job.client, job.connection))
		}
		if !valid {
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
		query := `SELECT job_id::text,client_id::text,connection_id::text,state,before_job_revision,job_revision,before_connection_revision,connection_revision,snapshot_id::text,before_snapshot_revision,snapshot_revision FROM app.analytics_sync_finish($1::uuid,$2::uuid,$3::jsonb)`
		if job.provider == "woocommerce" {
			query = `SELECT job_id::text,client_id::text,connection_id::text,state,before_job_revision,job_revision,before_connection_revision,connection_revision,snapshot_id::text,before_snapshot_revision,snapshot_revision FROM app.commerce_sync_finish($1::uuid,$2::uuid,$3::jsonb)`
		}
		if err := q.QueryRow(ctx, query, job.id, *job.lease, raw).
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
	if w == nil || w.service == nil || w.adapter == nil || w.admission == nil || ctx == nil || ctx.Err() != nil {
		return false, ErrInvalid
	}
	operation, cancel := context.WithTimeout(correlation.New(ctx), 150*time.Second)
	defer cancel()
	provider, fallback := "ga4", "woocommerce"
	if w.cycles.Add(1)%2 == 0 {
		provider, fallback = fallback, provider
	}
	job, err := w.service.claim(operation, provider)
	if errors.Is(err, errNoWork) {
		job, err = w.service.claim(operation, fallback)
	}
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
	var workspace any
	credential, err := w.service.credential(operation, job)
	if err == nil {
		switch job.provider {
		case "ga4":
			request := ga4.Request{ClientID: job.client, ConnectionID: job.connection, PropertyID: *job.account, Since: job.period().since, Until: job.period().until}
			result, err := w.adapter.FetchFenced(operation, credential.analytics, request, func(ctx context.Context) error { return w.service.fence(ctx, job) })
			if err == nil {
				workspace = &result
			}
		case "woocommerce":
			adapter, err := woocommerce.NewAdapter(*job.account, w.admission)
			if err == nil {
				result, err := adapter.FetchFenced(operation, credential.commerce, job.period().expectation(job.client, job.connection), func(ctx context.Context) bool { return w.service.fence(ctx, job) == nil })
				if err == nil {
					workspace = &result
				}
			}
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
