//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/auditreader"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/budget"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
)

const budgetFunctions = `app.integration_encryption_reserve(uuid,uuid,uuid,text,bytea),app.integration_encryption_binding(uuid,uuid,uuid)`

type budgetFixture struct {
	*connectionFixture
	budget *budget.Service
	ring   *credentials.Keyring
}

func syntheticRing(t *testing.T, label string, material byte) *credentials.Keyring {
	t.Helper()
	r, e := credentials.New(label, map[string][]byte{label: bytes.Repeat([]byte{material}, 32)})
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func newBudgetFixture(t *testing.T) *budgetFixture {
	t.Helper()
	f := newConnectionFixture(t)
	f.seed(t, clientAID, 1, 1)
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+budgetFunctions+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	r := syntheticRing(t, "synthetic-primary", 0x6b)
	s, e := budget.NewService(f.runtime, r)
	if e != nil {
		t.Fatal(e)
	}
	return &budgetFixture{f, s, r}
}
func (f *budgetFixture) accounting(t *testing.T) (int64, int) {
	t.Helper()
	var count int64
	var events int
	if e := f.admin.QueryRow(f.base.ctx, `SELECT coalesce(sum(reservations),0)::bigint,(SELECT count(*) FROM app.audit_events WHERE resource_kind='integration_encryption') FROM app.integration_encryption_keys`).Scan(&count, &events); e != nil {
		t.Fatal(e)
	}
	return count, events
}
func (f *budgetFixture) seedCount(t *testing.T, r *credentials.Keyring, n int64) {
	t.Helper()
	label, digest, e := r.ActiveKeyIdentity()
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.admin.Exec(f.base.ctx, `INSERT INTO app.integration_encryption_keys(key_label,fingerprint,reservations) VALUES($1,$2,$3)`, label, digest[:], n); e != nil {
		t.Fatal(e)
	}
}
func budgetBinding(client, connection string) credentials.Binding {
	return credentials.Binding{ClientID: client, ConnectionID: connection, Provider: "meta_ads", Purpose: "access_token"}
}

func TestIntegrationBudgetSealRotationRestartAndSafeAudit(t *testing.T) {
	f := newBudgetFixture(t)
	ctx := correlation.New(f.base.ctx)
	secret := []byte("synthetic-provider-token-never-log")
	result, e := f.budget.Seal(ctx, f.actor, clientAID, connectionID(1), secret)
	if e != nil {
		t.Fatal(e)
	}
	if result.Revision != 9223372036854775807 || result.Generation != 1 {
		t.Fatal("trusted storage fence lost precision")
	}
	if p, e := f.ring.Open(budgetBinding(clientAID, connectionID(1)), result.Envelope); e != nil || !bytes.Equal(p, secret) {
		t.Fatal("budgeted ciphertext failed authentication", e)
	} else {
		clear(p)
	}
	rotated, e := credentials.New("synthetic-next", map[string][]byte{"synthetic-primary": bytes.Repeat([]byte{0x6b}, 32), "synthetic-next": bytes.Repeat([]byte{0x7c}, 32)})
	if e != nil {
		t.Fatal(e)
	}
	next, e := budget.NewService(f.runtime, rotated)
	if e != nil {
		t.Fatal(e)
	}
	rewrapped, e := next.Rewrap(correlation.New(ctx), f.actor, clientAID, connectionID(1), result.Envelope)
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Equal(result.Envelope.Binary(), rewrapped.Envelope.Binary()) {
		t.Fatal("rewrap reused ciphertext")
	}
	if p, e := rotated.Open(budgetBinding(clientAID, connectionID(1)), rewrapped.Envelope); e != nil || !bytes.Equal(p, secret) {
		t.Fatal("rewrap changed credential", e)
	} else {
		clear(p)
	}
	rebuilt, e := budget.NewService(f.runtime, syntheticRing(t, "synthetic-primary", 0x6b))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = rebuilt.Seal(correlation.New(ctx), f.actor, clientAID, connectionID(1), secret); e != nil {
		t.Fatal(e)
	}
	if count, events := f.accounting(t); count != 3 || events != 3 {
		t.Fatal("restart/rotation lost accounting", count, events)
	}
	var raw string
	if e = f.admin.QueryRow(ctx, `SELECT string_agg(row_to_json(e)::text,'') FROM app.audit_events e WHERE resource_kind='integration_encryption'`).Scan(&raw); e != nil {
		t.Fatal(e)
	}
	label, digest, _ := f.ring.ActiveKeyIdentity()
	for _, private := range []string{string(secret), label, hex.EncodeToString(digest[:]), "fingerprint", "reservations", "990001", "ciphertext"} {
		if strings.Contains(raw, private) {
			t.Fatal("private data in reservation audit")
		}
	}
	if _, e = f.admin.Exec(ctx, `GRANT EXECUTE ON FUNCTION app.audit_reader_detail(uuid,uuid,uuid) TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	reader, e := auditreader.NewService(f.runtime)
	if e != nil {
		t.Fatal(e)
	}
	var id string
	if e = f.admin.QueryRow(ctx, `SELECT id::text FROM app.audit_events WHERE resource_kind='integration_encryption' LIMIT 1`).Scan(&id); e != nil {
		t.Fatal(e)
	}
	d, e := reader.Detail(ctx, f.actor, "", id)
	if e != nil || d.Before == nil || d.After == nil || *d.Before.Exists || !*d.After.Exists || d.EventType != "integration_encryption.created" {
		t.Fatal("typed audit projection incompatible", e)
	}
	if strings.Contains(fmt.Sprintf("%+v %#v", result, result), string(secret)) {
		t.Fatal("result formatting leaked plaintext")
	}
	if _, e = json.Marshal(result); e == nil {
		t.Fatal("opaque envelope serialized")
	}
}

func TestIntegrationBudgetConcurrentCapAndNoIdentityReset(t *testing.T) {
	f := newBudgetFixture(t)
	f.seedCount(t, f.ring, budget.MaxReservations-3)
	var wg sync.WaitGroup
	answers := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Go(func() {
			_, e := f.budget.Seal(correlation.New(f.base.ctx), f.actor, clientAID, connectionID(1), []byte("synthetic"))
			answers <- e
		})
	}
	wg.Wait()
	close(answers)
	success := 0
	for e := range answers {
		if e == nil {
			success++
		} else if e != budget.ErrExhausted {
			t.Fatal(e)
		}
	}
	if count, events := f.accounting(t); success != 3 || count != budget.MaxReservations || events != 3 {
		t.Fatal("concurrent limit overshoot", success, count, events)
	}
	for _, spec := range []struct {
		label    string
		material byte
	}{{"synthetic-primary", 0x7c}, {"renamed-primary", 0x6b}} {
		s, e := budget.NewService(f.runtime, syntheticRing(t, spec.label, spec.material))
		if e != nil {
			t.Fatal(e)
		}
		if _, e = s.Seal(correlation.New(f.base.ctx), f.actor, clientAID, connectionID(1), []byte("synthetic")); e != budget.ErrInvalid {
			t.Fatal("identity alias reset accounting", e)
		}
	}
	if count, events := f.accounting(t); count != budget.MaxReservations || events != 3 {
		t.Fatal("rejected alias changed budget")
	}
	fresh, e := budget.NewService(f.runtime, syntheticRing(t, "fresh-after-recovery", 0x7c))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = fresh.Seal(correlation.New(f.base.ctx), f.actor, clientAID, connectionID(1), []byte("synthetic")); e != nil {
		t.Fatal("fresh independent material cannot rotate", e)
	}
}

func TestIntegrationBudgetAuditFailureAndCryptoFailureNeverRefund(t *testing.T) {
	f := newBudgetFixture(t)
	ctx := correlation.New(f.base.ctx)
	if _, e := f.admin.Exec(ctx, `REVOKE INSERT `+auditColumns+` ON app.audit_events FROM `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	if r, e := f.budget.Seal(ctx, f.actor, clientAID, connectionID(1), []byte("synthetic")); e != budget.ErrUnavailable || len(r.Envelope.Binary()) != 0 {
		t.Fatal("audit failure returned ciphertext", e)
	}
	if count, events := f.accounting(t); count != 0 || events != 0 {
		t.Fatal("audit failure left partial accounting")
	}
	if _, e := f.admin.Exec(ctx, `GRANT INSERT `+auditColumns+` ON app.audit_events TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	wrong, e := f.ring.Seal(budgetBinding(clientBID, connectionID(1)), []byte("synthetic"))
	if e != nil {
		t.Fatal(e)
	}
	if r, e := f.budget.Rewrap(ctx, f.actor, clientAID, connectionID(1), wrong); e != credentials.ErrOpen || len(r.Envelope.Binary()) != 0 {
		t.Fatal("wrong binding returned ciphertext", e)
	}
	if count, events := f.accounting(t); count != 1 || events != 1 {
		t.Fatal("committed failed attempt refunded capacity")
	}
}

func TestIntegrationBudgetCommitFailureAndSingleConnectionPool(t *testing.T) {
	f := newBudgetFixture(t)
	ctx := correlation.New(f.base.ctx)
	// A deferred failure occurs at commit, after the event was inserted.
	if _, e := f.admin.Exec(ctx, `CREATE FUNCTION app.test_budget_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='synthetic commit failure'; END $$;
	CREATE CONSTRAINT TRIGGER test_budget_commit_failure AFTER INSERT OR UPDATE ON app.integration_encryption_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.test_budget_commit_failure()`); e != nil {
		t.Fatal(e)
	}
	if r, e := f.budget.Seal(ctx, f.actor, clientAID, connectionID(1), []byte("synthetic")); e != budget.ErrUnavailable || len(r.Envelope.Binary()) != 0 {
		t.Fatal("failed commit returned ciphertext", e)
	}
	if n, events := f.accounting(t); n != 0 || events != 0 {
		t.Fatal("failed commit left partial accounting")
	}
	if _, e := f.admin.Exec(ctx, `DROP TRIGGER test_budget_commit_failure ON app.integration_encryption_keys; DROP FUNCTION app.test_budget_commit_failure()`); e != nil {
		t.Fatal(e)
	}
	config := f.runtime.Config().Copy()
	config.MaxConns = 1
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	s, e := budget.NewService(pool, f.ring)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Seal(ctx, f.actor, clientAID, connectionID(1), []byte("synthetic")); e != nil {
		t.Fatal("sequential transactions require extra pool connection", e)
	}
	pool.Close()
	if r, e := s.Seal(ctx, f.actor, clientAID, connectionID(1), []byte("synthetic")); e != budget.ErrUnavailable || len(r.Envelope.Binary()) != 0 {
		t.Fatal("database failure returned ciphertext", e)
	}
}

func TestIntegrationBudgetAuthorizationAndConnectionState(t *testing.T) {
	for _, permissions := range [][]authorization.Permission{{authorization.ClientsView}, {authorization.IntegrationsManage}, {authorization.ClientsView, authorization.IntegrationsView, authorization.AnalyticsView}, {authorization.ClientsView, authorization.IntegrationsManage}} {
		t.Run(fmt.Sprint(permissions), func(t *testing.T) {
			f := newBudgetFixture(t)
			actor, _ := f.grant(t, permissions, clientAID)
			_, e := f.budget.Seal(correlation.New(f.base.ctx), actor, clientAID, connectionID(1), []byte("synthetic"))
			if len(permissions) == 2 && permissions[1] == authorization.IntegrationsManage {
				if e != nil {
					t.Fatal("explicit manage denied", e)
				}
			} else if e != budget.ErrMissing {
				t.Fatal("implicit management allowed", e)
			}
			if _, e = f.budget.Seal(correlation.New(f.base.ctx), actor, clientBID, connectionID(1), []byte("synthetic")); e != budget.ErrMissing {
				t.Fatal("foreign ownership allowed", e)
			}
		})
	}
	f := newBudgetFixture(t)
	for _, state := range []string{"pending", "connected", "reauthorization_required", "disconnect_pending", "revocation_failed", "disconnected"} {
		if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET state=$1 WHERE id=$2::uuid`, state, connectionID(1)); e != nil {
			t.Fatal(e)
		}
		_, e := f.budget.Seal(correlation.New(f.base.ctx), f.actor, clientAID, connectionID(1), []byte("synthetic"))
		if state == "pending" || state == "connected" || state == "reauthorization_required" {
			if e != nil {
				t.Fatal(e)
			}
		} else if e != budget.ErrMissing {
			t.Fatal("locally disconnected encryption allowed", e)
		}
	}
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET state='pending' WHERE id=$1::uuid`, connectionID(1)); e != nil {
		t.Fatal(e)
	}
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID); e != nil {
		t.Fatal(e)
	}
	if _, e := f.budget.Seal(correlation.New(f.base.ctx), f.actor, clientAID, connectionID(1), []byte("synthetic")); e != budget.ErrMissing {
		t.Fatal("archived client encryption allowed", e)
	}
}

func waitBudgetLock(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var waiting bool
		if e := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory')`).Scan(&waiting); e != nil {
			t.Fatal(e)
		}
		if waiting {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("operation did not wait on lifecycle/barrier lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestIntegrationBudgetQueuedRevocationBeforeReservation(t *testing.T) {
	for _, scenario := range []string{"assignment", "client view", "manage", "disabled"} {
		t.Run(scenario, func(t *testing.T) {
			f := newBudgetFixture(t)
			actor, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage}, clientAID)
			ctx, cancel := context.WithTimeout(correlation.New(f.base.ctx), 8*time.Second)
			defer cancel()
			tx, e := f.admin.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback(ctx)
			if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); e != nil {
				t.Fatal(e)
			}
			switch scenario {
			case "assignment":
				_, e = tx.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, assignment)
			case "disabled":
				_, e = tx.Exec(ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, actor)
			default:
				key := "clients.view"
				if scenario == "manage" {
					key = "integrations.manage"
				}
				_, e = tx.Exec(ctx, `UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id=(SELECT role_id FROM app.user_roles WHERE id=$1::uuid) AND permission_key=$2`, assignment, key)
			}
			if e != nil {
				t.Fatal(e)
			}
			answer := make(chan error, 1)
			go func() {
				r, e := f.budget.Seal(ctx, actor, clientAID, connectionID(1), []byte("synthetic"))
				if len(r.Envelope.Binary()) > 0 {
					answer <- fmt.Errorf("ciphertext leaked")
					return
				}
				answer <- e
			}()
			waitBudgetLock(t, ctx, f.adminPool)
			if e = tx.Commit(ctx); e != nil {
				t.Fatal(e)
			}
			if e = <-answer; e != budget.ErrMissing {
				t.Fatal("stale grants used", e)
			}
			if count, events := f.accounting(t); count != 0 || events != 0 {
				t.Fatal("denied actor consumed capacity")
			}
		})
	}
}

func TestIntegrationBudgetCommittedReservationSurvivesRevocationCancellationAndDisconnect(t *testing.T) {
	for _, scenario := range []string{"revocation", "cancellation", "disconnect"} {
		t.Run(scenario, func(t *testing.T) {
			f := newBudgetFixture(t)
			actor, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage}, clientAID)
			ctx, cancel := context.WithTimeout(correlation.New(f.base.ctx), 8*time.Second)
			defer cancel()
			// Dedicated test DB only: block phase two before its fresh authorization check.
			if _, e := f.admin.Exec(ctx, `ALTER FUNCTION app.integration_encryption_binding(uuid,uuid,uuid) RENAME TO integration_encryption_binding_original;
		 CREATE FUNCTION app.integration_encryption_binding(actor uuid,client uuid,connection uuid) RETURNS TABLE(client_id uuid,connection_id uuid,provider text,revision bigint,generation bigint)
		 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
		 PERFORM pg_advisory_xact_lock(871092650210);
		 RETURN QUERY SELECT * FROM app.integration_encryption_binding_original(actor,client,connection); END $$;
		 REVOKE EXECUTE ON FUNCTION app.integration_encryption_binding(uuid,uuid,uuid) FROM PUBLIC;
		 GRANT EXECUTE ON FUNCTION app.integration_encryption_binding(uuid,uuid,uuid) TO `+f.runtimeRole); e != nil {
				t.Fatal(e)
			}
			blocker, e := f.admin.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer blocker.Rollback(ctx)
			if _, e = blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650210)`); e != nil {
				t.Fatal(e)
			}
			answer := make(chan error, 1)
			go func() {
				r, e := f.budget.Seal(ctx, actor, clientAID, connectionID(1), []byte("synthetic"))
				if len(r.Envelope.Binary()) > 0 {
					answer <- fmt.Errorf("ciphertext leaked")
					return
				}
				answer <- e
			}()
			waitBudgetLock(t, ctx, f.adminPool)
			// The reservation transaction is already committed; a separate connection can see it.
			var count int64
			if e = f.adminPool.QueryRow(ctx, `SELECT reservations FROM app.integration_encryption_keys`).Scan(&count); e != nil || count != 1 {
				t.Fatal("encryption started before accounting commit", e)
			}
			if scenario == "cancellation" {
				cancel()
				if e = <-answer; e != budget.ErrUnavailable {
					t.Fatal("cancellation returned data", e)
				}
				if e = blocker.Rollback(f.base.ctx); e != nil {
					t.Fatal(e)
				}
				if n, events := f.accounting(t); n != 1 || events != 1 {
					t.Fatal("canceled attempt refunded capacity")
				}
				return
			}
			writer, e := f.adminPool.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer writer.Rollback(ctx)
			if _, e = writer.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); e != nil {
				t.Fatal(e)
			}
			if scenario == "disconnect" {
				_, e = writer.Exec(ctx, `UPDATE app.integration_connections SET state='disconnect_pending' WHERE id=$1::uuid`, connectionID(1))
			} else {
				_, e = writer.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, assignment)
			}
			if e != nil {
				t.Fatal(e)
			}
			if e = writer.Commit(ctx); e != nil {
				t.Fatal(e)
			}
			if e = blocker.Commit(ctx); e != nil {
				t.Fatal(e)
			}
			if e = <-answer; e != budget.ErrMissing {
				t.Fatal("phase-two revocation ignored", e)
			}
			if n, events := f.accounting(t); n != 1 || events != 1 {
				t.Fatal("postcommit denial refunded capacity")
			}
		})
	}
}

func TestIntegrationBudgetBindingHoldsLifecycleLockUntilTransactionEnds(t *testing.T) {
	f := newBudgetFixture(t)
	ctx, cancel := context.WithTimeout(f.base.ctx, 8*time.Second)
	defer cancel()
	tx, e := f.runtime.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT * FROM app.integration_encryption_binding($1::uuid,$2::uuid,$3::uuid)`, f.actor, clientAID, connectionID(1)); e != nil {
		t.Fatal(e)
	}
	writer, e := f.admin.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer writer.Rollback(ctx)
	answer := make(chan error, 1)
	go func() { _, e := writer.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); answer <- e }()
	waitBudgetLock(t, ctx, f.adminPool)
	select {
	case e := <-answer:
		t.Fatal("writer bypassed active encryption transaction", e)
	default:
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = <-answer; e != nil {
		t.Fatal(e)
	}
}

func TestIntegrationBudgetRuntimeAndHistoryBoundaries(t *testing.T) {
	f := newBudgetFixture(t)
	f.seedCount(t, f.ring, 1)
	for _, values := range []string{
		"gen_random_uuid(),'valid-label',decode(repeat('9d',32),'hex'),16777217,clock_timestamp()",
		"gen_random_uuid(),'valid-label',decode(repeat('9d',32),'hex'),-1,clock_timestamp()",
		"gen_random_uuid(),'bad label',decode(repeat('9d',32),'hex'),0,clock_timestamp()",
		"gen_random_uuid(),'valid-label',decode(repeat('9d',31),'hex'),0,clock_timestamp()",
		"gen_random_uuid(),'valid-label',decode(repeat('00',32),'hex'),0,clock_timestamp()",
		"gen_random_uuid(),'valid-label',decode(repeat('9d',32),'hex'),0,'infinity'",
		"'00000000-0000-0000-0000-000000000000','valid-label',decode(repeat('9d',32),'hex'),0,clock_timestamp()",
	} {
		if _, e := f.admin.Exec(f.base.ctx, `INSERT INTO app.integration_encryption_keys(id,key_label,fingerprint,reservations,created_at) VALUES(`+values+`)`); e == nil {
			t.Fatal("invalid accounting passed table constraints")
		}
	}
	for _, sql := range []string{`SELECT * FROM app.integration_encryption_keys`, `UPDATE app.integration_encryption_keys SET reservations=0`, `DELETE FROM app.integration_encryption_keys`, `TRUNCATE app.integration_encryption_keys`, `SELECT app.integration_encryption_history_guard()`} {
		if _, e := f.runtime.Exec(f.base.ctx, sql); e == nil {
			t.Fatal("runtime accounting bypass", sql)
		}
	}
	for _, sql := range []string{`UPDATE app.integration_encryption_keys SET reservations=0`, `UPDATE app.integration_encryption_keys SET reservations=3`, `UPDATE app.integration_encryption_keys SET key_label='renamed',reservations=reservations+1`, `UPDATE app.integration_encryption_keys SET fingerprint=decode(repeat('11',32),'hex'),reservations=reservations+1`, `DELETE FROM app.integration_encryption_keys`, `TRUNCATE app.integration_encryption_keys`} {
		if _, e := f.admin.Exec(f.base.ctx, sql); e == nil {
			t.Fatal("accounting history rewritten", sql)
		}
	}
	role, url := f.base.role(t)
	if _, e := f.admin.Exec(f.base.ctx, `GRANT USAGE ON SCHEMA app TO `+pgx.Identifier{role}.Sanitize()); e != nil {
		t.Fatal(e)
	}
	p, e := pgxpool.New(f.base.ctx, url)
	if e != nil {
		t.Fatal(e)
	}
	defer p.Close()
	for _, fn := range []string{"app.integration_encryption_reserve(uuid,uuid,uuid,text,bytea)", "app.integration_encryption_binding(uuid,uuid,uuid)", "app.integration_encryption_history_guard()"} {
		var allowed bool
		if e = p.QueryRow(f.base.ctx, `SELECT has_function_privilege(current_user,$1,'EXECUTE')`, fn).Scan(&allowed); e != nil || allowed {
			t.Fatal("PUBLIC accounting function accessible", e)
		}
	}
	for _, fn := range []string{"app.integration_encryption_reserve(uuid,uuid,uuid,text,bytea)", "app.integration_encryption_binding(uuid,uuid,uuid)"} {
		var secure bool
		if e := f.admin.QueryRow(f.base.ctx, `SELECT prosecdef AND provolatile='v' AND lower(array_to_string(proconfig,',')) LIKE '%search_path=pg_catalog%' AND lower(array_to_string(proconfig,',')) LIKE '%timezone=utc%' FROM pg_proc WHERE oid=$1::regprocedure`, fn).Scan(&secure); e != nil || !secure {
			t.Fatal("unsafe accounting definer", e)
		}
	}
	var helper, tableAccess bool
	if e = f.runtime.QueryRow(f.base.ctx, `SELECT has_function_privilege(current_user,'app.integration_encryption_history_guard()','EXECUTE'),has_table_privilege(current_user,'app.integration_encryption_keys','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`).Scan(&helper, &tableAccess); e != nil || helper || tableAccess {
		t.Fatal("runtime private privileges", e)
	}
	if _, e = provider(t, f.base).Down(f.base.ctx); e == nil {
		t.Fatal("budget history rollback allowed")
	}
	if count, _ := f.accounting(t); count != 1 {
		t.Fatal("refused rollback lost accounting")
	}
}

func TestIntegrationBudgetEmptyRollbackAndAuditOnlyHistory(t *testing.T) {
	f := newBudgetFixture(t)
	p := provider(t, f.base)
	if _, e := p.Down(f.base.ctx); e != nil {
		t.Fatal(e)
	}
	if _, e := p.Up(f.base.ctx); e != nil {
		t.Fatal(e)
	}
	if _, e := f.budget.Seal(correlation.New(f.base.ctx), f.actor, clientAID, connectionID(1), []byte("synthetic")); e != budget.ErrUnavailable {
		t.Fatal("recreated functions inherited runtime grants", e)
	}
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+budgetFunctions+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	if _, e := f.budget.Seal(correlation.New(f.base.ctx), f.actor, clientAID, connectionID(1), []byte("synthetic")); e != nil {
		t.Fatal("regrant failed", e)
	}
	other := newBudgetFixture(t)
	if _, e := other.runtime.Exec(other.base.ctx, `INSERT INTO app.audit_events `+auditColumns+` VALUES('user',$1::uuid,'integration_encryption.created','integration_encryption',gen_random_uuid(),$2::uuid,$3,'{"exists":false}','{"exists":true}','{"source":"cli"}')`, other.actor, clientAID, correlation.ID(correlation.New(other.base.ctx))); e != nil {
		t.Fatal(e)
	}
	if _, e := provider(t, other.base).Down(other.base.ctx); e == nil {
		t.Fatal("reservation audit rollback erased history")
	}
}
