package analytics

import (
	"context"

	"github.com/theroisey/else/backend/internal/integrations/providers/ga4"
	"github.com/theroisey/else/backend/internal/integrations/providers/metaads"
	"github.com/theroisey/else/backend/internal/integrations/providers/woocommerce"
	"github.com/theroisey/else/backend/internal/integrations/vault"
)

// Typed provider periods share credential accounting and queue/audit operations,
// while preserving property dates versus UTC seconds and explicit currency.
type syncPeriod struct {
	provider, since, until, start, end, currency string
}

func (p syncPeriod) valid(client, connection string) bool {
	if p.provider == "ga4" || p.provider == "meta_ads" {
		return validPeriod(p.since, p.until) && p.start == "" && p.end == "" && p.currency == ""
	}
	return p.provider == "woocommerce" && p.since == "" && p.until == "" && woocommerce.ValidExpectation(p.expectation(client, connection))
}

func (p syncPeriod) expectation(client, connection string) woocommerce.Expectation {
	return woocommerce.Expectation{ClientID: client, ConnectionID: connection, Start: p.start, End: p.end, Currency: p.currency, PerPage: 100}
}

func (p syncPeriod) validCredential(raw []byte) bool {
	if p.provider == "ga4" {
		_, err := ga4.ParseServiceAccount(raw)
		return err == nil
	}
	if p.provider == "woocommerce" {
		_, err := woocommerce.ParseReadKey(raw)
		return err == nil
	}
	if p.provider == "meta_ads" {
		_, err := metaads.ParseReadToken(raw)
		return err == nil
	}
	return false
}

func (p syncPeriod) cancelQuery() string {
	if p.provider == "meta_ads" {
		return `SELECT id::text,before_revision,after_revision FROM app.marketing_sync_cancel($1::uuid,$2::uuid,$3::uuid)`
	}
	if p.provider == "woocommerce" {
		return `SELECT id::text,before_revision,after_revision FROM app.commerce_sync_cancel($1::uuid,$2::uuid,$3::uuid)`
	}
	return `SELECT id::text,before_revision,after_revision FROM app.analytics_sync_cancel($1::uuid,$2::uuid,$3::uuid)`
}

func (p syncPeriod) enqueueQuery(actor, client, connection string, checkpoint vault.Checkpoint, job string, changed bool) (string, []any) {
	args := []any{actor, client, connection, checkpoint.ConnectionRevision, checkpoint.Generation, checkpoint.CredentialRevision}
	if p.provider == "meta_ads" {
		return `SELECT job_id::text,connection_revision,job_revision FROM app.marketing_sync_enqueue($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::date,$8::date,$9::uuid,$10)`, append(args, p.since, p.until, job, changed)
	}
	if p.provider == "woocommerce" {
		return `SELECT job_id::text,connection_revision,job_revision FROM app.commerce_sync_enqueue($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9,$10::uuid,$11)`, append(args, p.start, p.end, p.currency, job, changed)
	}
	return `SELECT job_id::text,connection_revision,job_revision FROM app.analytics_sync_enqueue($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::date,$8::date,$9::uuid,$10)`, append(args, p.since, p.until, job, changed)
}

func (s *Service) SetupCommerce(ctx context.Context, actor, client, connection, expected, start, end, currency string, plaintext []byte) (Queued, error) {
	return s.setup(ctx, actor, client, connection, expected, syncPeriod{provider: "woocommerce", start: start, end: end, currency: currency}, plaintext)
}

func (s *Service) EnqueueCommerce(ctx context.Context, actor, client, connection, expected, start, end, currency string) (Queued, error) {
	return s.enqueue(ctx, actor, client, connection, expected, syncPeriod{provider: "woocommerce", start: start, end: end, currency: currency})
}
