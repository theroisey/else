//go:build integration

package integration

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
	"github.com/theroisey/else/backend/internal/integrations/rotation"
)

const rotationFunction = `app.integration_rotation_candidates(uuid,uuid,text,bytea,uuid,integer)`

type rotationFixture struct {
	*vaultFixture
	ring     *credentials.Keyring
	rotation *rotation.Service
}

func newRotationFixture(t *testing.T, count int) *rotationFixture {
	t.Helper()
	f := newVaultFixture(t)
	grantPreflight(t, f.budgetFixture)
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+rotationFunction+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	if count > 1 {
		f.seed(t, clientAID, 2, count-1)
	}
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET revision=1 WHERE client_id=$1::uuid`, clientAID); e != nil {
		t.Fatal(e)
	}
	for n := 1; n <= count; n++ {
		ctx := correlation.New(f.base.ctx)
		c, e := f.vault.Inspect(ctx, f.actor, clientAID, connectionID(n))
		if e != nil {
			t.Fatal(e)
		}
		if _, e = f.vault.Replace(ctx, f.actor, clientAID, connectionID(n), c, []byte("synthetic-batch-token")); e != nil {
			t.Fatal(e)
		}
	}
	ring := retainedRing(t, "synthetic-fresh", 0x6b)
	s, e := rotation.NewService(f.runtime, ring)
	if e != nil {
		t.Fatal(e)
	}
	return &rotationFixture{f, ring, s}
}

func rotationIDs(ctx context.Context, pool *pgxpool.Pool, actor, client string, ring *credentials.Keyring, after any, limit int) ([]string, error) {
	label, digest, _ := ring.ActiveKeyIdentity()
	rows, e := pool.Query(ctx, `SELECT connection_id::text,connection_revision,connection_generation,credential_revision FROM app.integration_rotation_candidates($1::uuid,$2::uuid,$3,$4,$5::uuid,$6)`, actor, client, label, digest[:], after, limit)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		var a, b, c int64
		if e = rows.Scan(&id, &a, &b, &c); e != nil {
			return nil, e
		}
		if a < 1 || b < 1 || c < 1 {
			return nil, fmt.Errorf("invalid synthetic rotation checkpoint")
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (f *rotationFixture) assertRow(t *testing.T, n int, active bool, connectionRevision, credentialRevision, generation int64) {
	t.Helper()
	var matches bool
	var a, b, c int64
	var raw []byte
	label, _, _ := f.ring.ActiveKeyIdentity()
	if e := f.admin.QueryRow(f.base.ctx, `SELECT k.key_label=$2,c.revision,s.revision,c.generation,s.envelope FROM app.integration_connections c JOIN app.integration_credentials s ON s.connection_id=c.id JOIN app.integration_encryption_keys k ON k.id=s.key_id WHERE c.id=$1::uuid`, connectionID(n), label).Scan(&matches, &a, &b, &c, &raw); e != nil {
		t.Fatal(e)
	}
	defer clear(raw)
	if matches != active || a != connectionRevision || b != credentialRevision || c != generation {
		t.Fatal("row identity/revision/generation changed unexpectedly")
	}
	envelope, e := credentials.ParseEnvelope(raw)
	if e != nil {
		t.Fatal("synthetic framing failed")
	}
	plain, e := f.ring.Open(budgetBinding(clientAID, connectionID(n)), envelope)
	if e != nil || string(plain) != "synthetic-batch-token" {
		t.Fatal("rotation changed synthetic token")
	}
	clear(plain)
}

func TestIntegrationRotationPagingRestartAndNoRepeatCapacity(t *testing.T) {
	f := newRotationFixture(t, 5)
	ctx := correlation.New(f.base.ctx)
	ids, e := rotationIDs(ctx, f.runtime, f.actor, clientAID, f.ring, nil, 2)
	if e != nil || len(ids) != 3 || ids[0] != connectionID(1) || ids[2] != connectionID(3) {
		t.Fatal("candidate lookahead/order failed", e)
	}
	if n, events := f.accounting(t); n != 5 || events != 5 {
		t.Fatal("planning mutated accounting")
	}
	after := ""
	for _, want := range []int{2, 2, 1} {
		r, e := f.rotation.Run(ctx, f.actor, clientAID, after, 2)
		if e != nil || !r.PageComplete || r.Pending != "" || r.Rewrapped != want || r.More != (want == 2) {
			t.Fatal("bounded page result disagreed", e)
		}
		after = r.ResumeAfter
		// Reconstruct the service for each explicitly requested page.
		f.rotation, e = rotation.NewService(f.runtime, f.ring)
		if e != nil {
			t.Fatal(e)
		}
	}
	for n := 1; n <= 5; n++ {
		f.assertRow(t, n, true, 3, 2, 2)
	}
	if n, events := f.accounting(t); n != 10 || events != 10 {
		t.Fatal("batch lost irreversible reservations")
	}
	if a, b := f.mutationEvents(t); a != 10 || b != 10 {
		t.Fatal("batch lost per-row atomic audits")
	}
	for _, cursor := range []string{"", after} {
		r, e := f.rotation.Run(ctx, f.actor, clientAID, cursor, 100)
		if e != nil || r != (rotation.Result{ResumeAfter: cursor, PageComplete: true}) {
			t.Fatal("restart rewrapped active rows", e)
		}
	}
	if n, events := f.accounting(t); n != 10 || events != 10 {
		t.Fatal("restart burned extra capacity")
	}
}

func TestIntegrationRotationExcludesRetainedIneligibleAndOtherClientRows(t *testing.T) {
	f := newRotationFixture(t, 6)
	for n, state := range map[int]string{2: "revocation_failed", 3: "disconnect_pending", 4: "disconnected"} {
		if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET state=$2 WHERE id=$1::uuid`, connectionID(n), state); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET generation=generation+1 WHERE id=$1::uuid`, connectionID(5)); e != nil {
		t.Fatal(e)
	}
	f.seed(t, clientBID, 7, 1)
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET revision=1 WHERE id=$1::uuid`, connectionID(7)); e != nil {
		t.Fatal(e)
	}
	c, e := f.vault.Inspect(correlation.New(f.base.ctx), f.actor, clientBID, connectionID(7))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.vault.Replace(correlation.New(f.base.ctx), f.actor, clientBID, connectionID(7), c, []byte("synthetic-other-client")); e != nil {
		t.Fatal(e)
	}
	r, e := f.rotation.Run(correlation.New(f.base.ctx), f.actor, clientAID, "", 100)
	if e != nil || r.Rewrapped != 2 || !r.PageComplete || r.More || r.ResumeAfter != connectionID(6) {
		t.Fatal("ineligible/cross-client row rotated", e)
	}
	for _, n := range []int{2, 3, 4} {
		f.assertRow(t, n, false, 2, 1, 2)
	}
	f.assertRow(t, 5, false, 2, 1, 3)
	// Even excluded rows still require their retained key at preflight.
	missing, e := rotation.NewService(f.runtime, syntheticRing(t, "synthetic-fresh", 0x73))
	if e != nil {
		t.Fatal(e)
	}
	if r, e := missing.Run(correlation.New(f.base.ctx), f.actor, clientAID, "", 100); e != rotation.ErrUnavailable || r.PageComplete {
		t.Fatal("excluded retained-key requirement bypassed")
	}
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID); e != nil {
		t.Fatal(e)
	}
	if r, e := f.rotation.Run(correlation.New(f.base.ctx), f.actor, clientAID, "", 100); e != rotation.ErrMissing || r.PageComplete {
		t.Fatal("archived empty scan accepted")
	}
}

func TestIntegrationRotationPartialCommitFailureAndExplicitResume(t *testing.T) {
	f := newRotationFixture(t, 3)
	if _, e := f.admin.Exec(f.base.ctx, `CREATE FUNCTION app.synthetic_rotation_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='synthetic-private-commit'; END $$;
 CREATE CONSTRAINT TRIGGER synthetic_rotation_commit_failure AFTER UPDATE ON app.integration_credentials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.connection_id='e3000000-0000-4000-8000-000000000002'::uuid) EXECUTE FUNCTION app.synthetic_rotation_commit_failure()`); e != nil {
		t.Fatal(e)
	}
	r, e := f.rotation.Run(correlation.New(f.base.ctx), f.actor, clientAID, "", 3)
	if e != rotation.ErrUnavailable || r != (rotation.Result{Rewrapped: 1, ResumeAfter: connectionID(1), Pending: connectionID(2)}) {
		t.Fatal("uncertain/failed row advanced progress", e)
	}
	f.assertRow(t, 1, true, 3, 2, 2)
	f.assertRow(t, 2, false, 2, 1, 2)
	f.assertRow(t, 3, false, 2, 1, 2)
	if n, events := f.accounting(t); n != 5 || events != 5 {
		t.Fatal("failure retried or refunded reservation")
	}
	if a, b := f.mutationEvents(t); a != 4 || b != 4 {
		t.Fatal("failed row left partial mutation/audit")
	}
	if _, e := f.admin.Exec(f.base.ctx, `DROP TRIGGER synthetic_rotation_commit_failure ON app.integration_credentials; DROP FUNCTION app.synthetic_rotation_commit_failure()`); e != nil {
		t.Fatal(e)
	}
	// Fixture administrator has verified the failed row remained unchanged. Only
	// then make a new explicit request from the last confirmed cursor.
	next, e := f.rotation.Run(correlation.New(f.base.ctx), f.actor, clientAID, r.ResumeAfter, 3)
	if e != nil || next.Rewrapped != 2 || !next.PageComplete || next.More {
		t.Fatal("explicit reconciled resume failed", e)
	}
	if n, events := f.accounting(t); n != 7 || events != 7 {
		t.Fatal("resume repeated a confirmed row")
	}
}

func TestIntegrationRotationOneConnectionPoolTamperingAndExhaustion(t *testing.T) {
	for _, scenario := range []string{"one connection", "tamper", "exhausted"} {
		t.Run(scenario, func(t *testing.T) {
			f := newRotationFixture(t, 1)
			service := f.rotation
			if scenario == "one connection" {
				cfg := f.runtime.Config().Copy()
				cfg.MaxConns = 1
				pool, e := pgxpool.NewWithConfig(f.base.ctx, cfg)
				if e != nil {
					t.Fatal(e)
				}
				defer pool.Close()
				service, e = rotation.NewService(pool, f.ring)
				if e != nil {
					t.Fatal(e)
				}
			} else if scenario == "tamper" {
				if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_credentials SET envelope=set_byte(envelope,octet_length(envelope)-1,get_byte(envelope,octet_length(envelope)-1)#1),revision=revision+1 WHERE connection_id=$1::uuid`, connectionID(1)); e != nil {
					t.Fatal(e)
				}
			} else {
				f.seedCount(t, f.ring, 1<<24)
			}
			r, e := service.Run(correlation.New(f.base.ctx), f.actor, clientAID, "", 1)
			switch scenario {
			case "one connection":
				if e != nil || r.Rewrapped != 1 || !r.PageComplete {
					t.Fatal("planning leaked pool connection", e)
				}
			case "tamper":
				if e != rotation.ErrUnavailable || r.Rewrapped != 0 || r.Pending != connectionID(1) || r.PageComplete {
					t.Fatal("tampered row rotated", e)
				}
				if n, events := f.accounting(t); n != 2 || events != 2 {
					t.Fatal("tamper refunded or retried encryption")
				}
			case "exhausted":
				if e != rotation.ErrUnavailable || r != (rotation.Result{}) {
					t.Fatal("exhausted startup wrote a row", e)
				}
			}
		})
	}
}

func TestIntegrationRotationIndependentGrantsAndEmptyIDORDenial(t *testing.T) {
	for _, permissions := range [][]authorization.Permission{
		{authorization.ClientsView}, {authorization.IntegrationsManage},
		{authorization.ClientsView, authorization.IntegrationsView, authorization.AnalyticsView},
		{authorization.ClientsView, authorization.IntegrationsManage},
	} {
		t.Run(fmt.Sprint(permissions), func(t *testing.T) {
			f := newRotationFixture(t, 1)
			actor, _ := f.grant(t, permissions, clientAID)
			r, e := f.rotation.Run(correlation.New(f.base.ctx), actor, clientAID, "", 1)
			allowed := len(permissions) == 2 && permissions[0] == authorization.ClientsView && permissions[1] == authorization.IntegrationsManage
			if allowed {
				if e != nil || r.Rewrapped != 1 {
					t.Fatal("exact management grants rejected", e)
				}
			} else if e != rotation.ErrMissing || r != (rotation.Result{}) {
				t.Fatal("implicit management allowed", e)
			}
			if r, e := f.rotation.Run(correlation.New(f.base.ctx), actor, clientBID, "", 100); e != rotation.ErrMissing || r != (rotation.Result{}) {
				t.Fatal("foreign empty client scan exposed", e)
			}
			if r, e := f.rotation.Run(correlation.New(f.base.ctx), actor, "e3000000-0000-4000-8000-000000000999", "", 100); e != rotation.ErrMissing || r != (rotation.Result{}) {
				t.Fatal("missing client scan accepted", e)
			}
		})
	}
}

func TestIntegrationRotationPrivatePrivilegesMalformedIdentityAndPopulatedRollback(t *testing.T) {
	f := newRotationFixture(t, 1)
	var secure, public bool
	if e := f.admin.QueryRow(f.base.ctx, `SELECT prosecdef AND provolatile='v' AND lower(array_to_string(proconfig,',')) LIKE '%search_path=pg_catalog%' AND lower(array_to_string(proconfig,',')) LIKE '%timezone=utc%',EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') FROM pg_proc WHERE oid=$1::regprocedure`, rotationFunction).Scan(&secure, &public); e != nil || !secure || public {
		t.Fatal("unsafe candidate definer", e)
	}
	for _, table := range []string{"app.integration_encryption_keys", "app.integration_credentials"} {
		if _, e := f.runtime.Exec(f.base.ctx, `SELECT * FROM `+table); e == nil {
			t.Fatal("runtime can select private table")
		}
	}
	for _, limit := range []int{0, 101} {
		if _, e := rotationIDs(f.base.ctx, f.runtime, f.actor, clientAID, f.ring, nil, limit); e == nil {
			t.Fatal("unbounded candidate request accepted")
		}
	}
	if _, e := rotationIDs(f.base.ctx, f.runtime, f.actor, clientAID, f.ring, "00000000-0000-0000-0000-000000000000", 1); e == nil {
		t.Fatal("zero cursor accepted")
	}
	for _, ring := range []*credentials.Keyring{syntheticRing(t, "synthetic-alias", 0x6b), syntheticRing(t, "synthetic-primary", 0x75)} {
		if _, e := rotationIDs(f.base.ctx, f.runtime, f.actor, clientAID, ring, nil, 1); e == nil {
			t.Fatal("conflicting active identity accepted")
		}
	}
	for _, sql := range []string{
		`SELECT * FROM app.integration_rotation_candidates($1::uuid,$2::uuid,NULL,NULL,NULL,1)`,
		`SELECT * FROM app.integration_rotation_candidates($1::uuid,$2::uuid,'x',decode('01','hex'),NULL,1)`,
		`SELECT * FROM app.integration_rotation_candidates($1::uuid,$2::uuid,'x',decode(repeat('00',32),'hex'),NULL,1)`,
		`SELECT * FROM app.integration_rotation_candidates($1::uuid,$2::uuid,'X',decode(repeat('01',32),'hex'),NULL,1)`,
	} {
		if _, e := f.runtime.Exec(f.base.ctx, sql, f.actor, clientAID); e == nil {
			t.Fatal("malformed candidate identity accepted")
		}
	}
	p := provider(t, f.base)
	if _, e := p.DownTo(f.base.ctx, 19); e != nil {
		t.Fatal(e)
	}
	f.assertRow(t, 1, false, 2, 1, 2)
	if n, events := f.accounting(t); n != 1 || events != 1 {
		t.Fatal("candidate down destroyed budget/history")
	}
	if r, e := f.rotation.Run(correlation.New(f.base.ctx), f.actor, clientAID, "", 1); e != rotation.ErrUnavailable || r.PageComplete {
		t.Fatal("removed candidate entrypoint callable")
	}
	if _, e := p.Up(f.base.ctx); e != nil {
		t.Fatal(e)
	}
	if r, e := f.rotation.Run(correlation.New(f.base.ctx), f.actor, clientAID, "", 1); e != rotation.ErrUnavailable || r.PageComplete {
		t.Fatal("recreated entrypoint retained EXECUTE")
	}
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+rotationFunction+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	if r, e := f.rotation.Run(correlation.New(f.base.ctx), f.actor, clientAID, "", 1); e != nil || r.Rewrapped != 1 || !r.PageComplete {
		t.Fatal("regrant did not recover rotation", e)
	}
}

func TestIntegrationRotationQueuedCandidateRevocationAndCancellation(t *testing.T) {
	f := newRotationFixture(t, 1)
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
	answers := make(chan error, 1)
	go func() { _, e := rotationIDs(ctx, f.runtime, actor, clientAID, f.ring, nil, 1); answers <- e }()
	waitBudgetLock(t, ctx, f.adminPool)
	if _, e = tx.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, assignment); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = <-answers; e == nil {
		t.Fatal("queued candidate selection used stale authorization")
	}
	block, e := f.admin.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer block.Rollback(ctx)
	if _, e = block.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); e != nil {
		t.Fatal(e)
	}
	short, done := context.WithTimeout(ctx, 50*time.Millisecond)
	if r, e := f.rotation.Run(short, f.actor, clientAID, "", 1); e != rotation.ErrUnavailable || r.PageComplete || r.Rewrapped != 0 {
		t.Fatal("cancelled preflight reported work")
	}
	done()
	if e = block.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	if r, e := f.rotation.Run(ctx, f.actor, clientAID, "", 1); e != nil || r.Rewrapped != 1 {
		t.Fatal("cancellation leaked planning lock/pool", e)
	}
}

func TestIntegrationRotationFreshPerRowFencesAndConcurrentCAS(t *testing.T) {
	for _, scenario := range []string{"revocation", "generation", "disconnect", "audit", "cancel", "concurrent"} {
		t.Run(scenario, func(t *testing.T) {
			f := newRotationFixture(t, 1)
			actor, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage}, clientAID)
			ctx, cancel := context.WithTimeout(correlation.New(f.base.ctx), 8*time.Second)
			defer cancel()
			block := f.blockWrite(t, ctx)
			type answer struct {
				r rotation.Result
				e error
			}
			answers := make(chan answer, 2)
			writers := 1
			if scenario == "concurrent" {
				writers = 2
			}
			for n := 0; n < writers; n++ {
				go func() { r, e := f.rotation.Run(ctx, actor, clientAID, "", 1); answers <- answer{r, e} }()
			}
			waitVaultWriters(t, ctx, f.adminPool, writers)
			want := rotation.ErrMissing
			if scenario == "cancel" {
				cancel()
				want = rotation.ErrUnavailable
			} else if scenario != "concurrent" {
				tx, e := f.adminPool.Begin(ctx)
				if e != nil {
					t.Fatal(e)
				}
				defer tx.Rollback(ctx)
				if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); e != nil {
					t.Fatal(e)
				}
				switch scenario {
				case "revocation":
					_, e = tx.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, assignment)
				case "generation":
					want = rotation.ErrConflict
					_, e = tx.Exec(ctx, `UPDATE app.integration_connections SET generation=generation+1 WHERE id=$1::uuid`, connectionID(1))
				case "disconnect":
					_, e = tx.Exec(ctx, `UPDATE app.integration_connections SET state='revocation_failed',revision=revision+1,generation=generation+1 WHERE id=$1::uuid`, connectionID(1))
				case "audit":
					want = rotation.ErrUnavailable
					_, e = tx.Exec(ctx, `REVOKE INSERT `+auditColumns+` ON app.audit_events FROM `+f.runtimeRole)
				}
				if e != nil {
					t.Fatal(e)
				}
				if e = tx.Commit(ctx); e != nil {
					t.Fatal(e)
				}
			}
			if scenario == "cancel" { // Keep the barrier until the canceled writer exits.
				a := <-answers
				if a.e != want || a.r != (rotation.Result{Pending: connectionID(1)}) {
					t.Fatal("cancelled row claimed progress", a.e)
				}
				_ = block.Rollback(f.base.ctx)
			} else {
				if e := block.Commit(ctx); e != nil {
					t.Fatal(e)
				}
				success := 0
				for n := 0; n < writers; n++ {
					a := <-answers
					if scenario == "concurrent" && a.e == nil {
						success++
						if a.r != (rotation.Result{Rewrapped: 1, ResumeAfter: connectionID(1), PageComplete: true}) {
							t.Fatal("concurrent winner lost progress")
						}
					} else {
						if scenario == "concurrent" {
							want = rotation.ErrConflict
						}
						if a.e != want || a.r != (rotation.Result{Pending: connectionID(1)}) {
							t.Fatal("fresh fence ignored or cursor advanced", a.e)
						}
					}
				}
				if scenario == "concurrent" && success != 1 {
					t.Fatal("multiple batch CAS winners")
				}
			}
			if n, events := f.accounting(t); n != int64(1+writers) || events != 1+writers {
				t.Fatal("failed batch row refunded/retried encryption")
			}
			wantMutations := 1
			if scenario == "concurrent" {
				wantMutations = 2
				f.assertRow(t, 1, true, 3, 2, 2)
			}
			if a, b := f.mutationEvents(t); a != wantMutations || b != wantMutations {
				t.Fatal("failed batch left partial mutation audit")
			}
		})
	}
}

func TestIntegrationRotationQuotaStopsAfterKnownCommit(t *testing.T) {
	f := newRotationFixture(t, 3)
	f.seedCount(t, f.ring, (1<<24)-1)
	r, e := f.rotation.Run(correlation.New(f.base.ctx), f.actor, clientAID, "", 3)
	if e != rotation.ErrExhausted || r != (rotation.Result{Rewrapped: 1, ResumeAfter: connectionID(1), Pending: connectionID(2)}) {
		t.Fatal("quota advanced incomplete page", e)
	}
	f.assertRow(t, 1, true, 3, 2, 2)
	f.assertRow(t, 2, false, 2, 1, 2)
	f.assertRow(t, 3, false, 2, 1, 2)
	if n, events := f.accounting(t); n != (1<<24)+3 || events != 4 {
		t.Fatal("quota exceeded or partial progress lost")
	}
}
