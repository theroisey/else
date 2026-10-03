//go:build integration

package integration

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/integrations/credentials"
	"github.com/theroisey/else/backend/internal/integrations/keysource"
)

const preflightFunction = `app.integration_key_preflight(text[],bytea[],text,boolean)`

func grantPreflight(t *testing.T, f *budgetFixture) {
	t.Helper()
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+preflightFunction+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
}
func retainedRing(t *testing.T, active string, primary byte) *credentials.Keyring {
	t.Helper()
	ring, e := credentials.New(active, map[string][]byte{"synthetic-primary": bytes.Repeat([]byte{primary}, 32), "synthetic-fresh": bytes.Repeat([]byte{0x73}, 32)})
	if e != nil {
		t.Fatal("synthetic ring failed")
	}
	return ring
}
func TestIntegrationKeyPreflightIdentityRetainedKeysAndDeclaredRestore(t *testing.T) {
	f := newVaultFixture(t)
	grantPreflight(t, f.budgetFixture)
	f.replace(t, f.checkpoint(t), "synthetic-preflight-token")
	beforeCount, beforeEvents := f.accounting(t)
	beforeCredential, beforeConnection := f.mutationEvents(t)
	for _, test := range []struct {
		name     string
		ring     *credentials.Keyring
		restored bool
		allowed  bool
	}{
		{"normal registered", f.ring, false, true},
		{"restored old active", f.ring, true, false},
		{"fresh active with retained", retainedRing(t, "synthetic-fresh", 0x6b), true, true},
		{"missing retained", syntheticRing(t, "synthetic-fresh", 0x73), false, false},
		{"changed retained material", retainedRing(t, "synthetic-fresh", 0x61), false, false},
		{"registered material relabeled", syntheticRing(t, "synthetic-alias", 0x6b), false, false},
		{"registered label wrong material", syntheticRing(t, "synthetic-primary", 0x62), false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			e := keysource.Preflight(f.base.ctx, f.runtime, test.ring, test.restored)
			if test.allowed && e != nil || !test.allowed && e != keysource.ErrUnavailable {
				t.Fatal("startup policy disagreed", e)
			}
		})
	}
	// Every retained row counts, including obsolete generation and local disable.
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET state='revocation_failed',revision=revision+1,generation=generation+1 WHERE id=$1::uuid`, connectionID(1)); e != nil {
		t.Fatal(e)
	}
	if e := keysource.Preflight(f.base.ctx, f.runtime, syntheticRing(t, "synthetic-fresh", 0x73), true); e != keysource.ErrUnavailable {
		t.Fatal("disabled/obsolete row lost retained key coverage")
	}
	if e := keysource.Preflight(f.base.ctx, f.runtime, retainedRing(t, "synthetic-fresh", 0x6b), true); e != nil {
		t.Fatal("retained disabled credential rejected", e)
	}
	if n, events := f.accounting(t); n != beforeCount || events != beforeEvents {
		t.Fatal("preflight consumed budget or audit")
	}
	if a, b := f.mutationEvents(t); a != beforeCredential || b != beforeConnection {
		t.Fatal("preflight emitted mutation events")
	}
	if f.stored(t, f.ring) != "synthetic-preflight-token" {
		t.Fatal("preflight altered ciphertext")
	}
}
func TestIntegrationKeyPreflightExhaustionFreshRestartAndNoMutation(t *testing.T) {
	f := newBudgetFixture(t)
	grantPreflight(t, f)
	f.seedCount(t, f.ring, 1<<24)
	if e := keysource.Preflight(f.base.ctx, f.runtime, f.ring, false); e != keysource.ErrUnavailable {
		t.Fatal("exhausted active accepted")
	}
	fresh := retainedRing(t, "synthetic-fresh", 0x6b)
	if e := keysource.Preflight(f.base.ctx, f.runtime, fresh, true); e != nil {
		t.Fatal("fresh restore rejected", e)
	}
	if e := keysource.Preflight(f.base.ctx, f.runtime, fresh, false); e != nil {
		t.Fatal("fresh normal rejected", e)
	}
	if n, events := f.accounting(t); n != 1<<24 || events != 0 {
		t.Fatal("preflight altered retained accounting")
	}
	var rows int
	if e := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.integration_encryption_keys`).Scan(&rows); e != nil || rows != 1 {
		t.Fatal("preflight registered fresh key")
	}
}
func TestIntegrationKeyPreflightMalformedInputsAndPrivileges(t *testing.T) {
	f := newBudgetFixture(t)
	if e := keysource.Preflight(f.base.ctx, f.runtime, f.ring, false); e != keysource.ErrUnavailable {
		t.Fatal("ungranted function callable")
	}
	grantPreflight(t, f)
	var secure, public bool
	if e := f.admin.QueryRow(f.base.ctx, `SELECT prosecdef AND provolatile='v' AND lower(array_to_string(proconfig,',')) LIKE '%search_path=pg_catalog%' AND lower(array_to_string(proconfig,',')) LIKE '%timezone=utc%',EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') FROM pg_proc WHERE oid=$1::regprocedure`, preflightFunction).Scan(&secure, &public); e != nil || !secure || public {
		t.Fatal("unsafe preflight definer", e)
	}
	for _, table := range []string{"app.integration_encryption_keys", "app.integration_credentials"} {
		tx, e := f.runtime.Begin(f.base.ctx)
		if e != nil {
			t.Fatal(e)
		}
		if _, e := tx.Exec(f.base.ctx, `SELECT * FROM `+table); e == nil {
			t.Fatal("runtime can read private table")
		}
		_ = tx.Rollback(f.base.ctx)
	}
	for _, sql := range []string{
		`SELECT app.integration_key_preflight(NULL,NULL,NULL,NULL)`,
		`SELECT app.integration_key_preflight('{}','{}','x',false)`,
		`SELECT app.integration_key_preflight(ARRAY['x','x'],ARRAY[decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex')],'x',false)`,
		`SELECT app.integration_key_preflight(ARRAY['x','y'],ARRAY[decode(repeat('01',32),'hex'),decode(repeat('01',32),'hex')],'x',false)`,
		`SELECT app.integration_key_preflight(ARRAY['x'],ARRAY[decode(repeat('00',32),'hex')],'x',false)`,
		`SELECT app.integration_key_preflight(ARRAY['x'],ARRAY[decode('01','hex')],'x',false)`,
		`SELECT app.integration_key_preflight(ARRAY['x'],ARRAY[decode(repeat('01',32),'hex')],'y',false)`,
		`SELECT app.integration_key_preflight(ARRAY['X'],ARRAY[decode(repeat('01',32),'hex')],'X',false)`,
		`SELECT app.integration_key_preflight(ARRAY['x',NULL],ARRAY[decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex')],'x',false)`,
		`SELECT app.integration_key_preflight('[0:0]={x}'::text[],ARRAY[decode(repeat('01',32),'hex')],'x',false)`,
		`SELECT app.integration_key_preflight(ARRAY[['x']],ARRAY[decode(repeat('01',32),'hex')],'x',false)`,
	} {
		var allowed bool
		if e := f.runtime.QueryRow(f.base.ctx, sql).Scan(&allowed); e != nil || allowed {
			t.Fatal("malformed preflight did not fail closed", e)
		}
	}
	if e := keysource.Preflight(nil, f.runtime, f.ring, false); e != keysource.ErrUnavailable {
		t.Fatal("nil context accepted")
	}
	if e := keysource.Preflight(f.base.ctx, nil, f.ring, false); e != keysource.ErrUnavailable {
		t.Fatal("nil pool accepted")
	}
	if e := keysource.Preflight(f.base.ctx, f.runtime, nil, false); e != keysource.ErrUnavailable {
		t.Fatal("nil keyring accepted")
	}
}
func TestIntegrationKeyPreflightQueuedSnapshotAndCancellation(t *testing.T) {
	f := newBudgetFixture(t)
	grantPreflight(t, f)
	ctx, cancel := context.WithTimeout(f.base.ctx, 8*time.Second)
	defer cancel()
	tx, e := f.admin.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); e != nil {
		t.Fatal(e)
	}
	label, digest, _ := f.ring.ActiveKeyIdentity()
	if _, e = tx.Exec(ctx, `INSERT INTO app.integration_encryption_keys(key_label,fingerprint,reservations) VALUES($1,$2,1)`, label, digest[:]); e != nil {
		t.Fatal(e)
	}
	answers := make(chan error, 1)
	go func() { answers <- keysource.Preflight(ctx, f.runtime, f.ring, true) }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var n int
		if e := f.adminPool.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=($1::bigint & 4294967295)::oid AND NOT granted`, int64(871092650209)).Scan(&n); e != nil {
			t.Fatal(e)
		}
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("preflight did not wait for lifecycle lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = <-answers; e != keysource.ErrUnavailable {
		t.Fatal("queued preflight used stale key history", e)
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
	if e = keysource.Preflight(short, f.runtime, f.ring, false); e != keysource.ErrUnavailable {
		t.Fatal("cancelled wait accepted")
	}
	done()
	if e = block.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	if e = keysource.Preflight(ctx, f.runtime, f.ring, false); e != nil {
		t.Fatal("cancelled preflight leaked lock/pool", e)
	}
}
func TestIntegrationKeyPreflightPopulatedDownUpPreservesHistoryAndRegrant(t *testing.T) {
	f := newVaultFixture(t)
	grantPreflight(t, f.budgetFixture)
	f.replace(t, f.checkpoint(t), "synthetic-retained")
	p := provider(t, f.base)
	if _, e := p.DownTo(f.base.ctx, 18); e != nil {
		t.Fatal(e)
	}
	if f.stored(t, f.ring) != "synthetic-retained" {
		t.Fatal("preflight rollback lost credential")
	}
	if count, events := f.accounting(t); count != 1 || events != 1 {
		t.Fatal("preflight rollback lost accounting/audit")
	}
	if e := keysource.Preflight(f.base.ctx, f.runtime, f.ring, false); e != keysource.ErrUnavailable {
		t.Fatal("removed entrypoint callable")
	}
	if _, e := p.Up(f.base.ctx); e != nil {
		t.Fatal(e)
	}
	if e := keysource.Preflight(f.base.ctx, f.runtime, f.ring, false); e != keysource.ErrUnavailable {
		t.Fatal("recreated function retained grant")
	}
	grantPreflight(t, f.budgetFixture)
	if e := keysource.Preflight(f.base.ctx, f.runtime, f.ring, false); e != nil {
		t.Fatal("regranted preflight failed", e)
	}
}
