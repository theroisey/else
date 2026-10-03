//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/auditreader"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
	"github.com/theroisey/else/backend/internal/integrations/vault"
)

const vaultFunctions = `app.integration_credential_read(uuid,uuid,uuid),app.integration_credential_write(uuid,uuid,uuid,bigint,bigint,bigint,text,bytea,bytea,boolean)`

type vaultFixture struct {
	*budgetFixture
	vault *vault.Service
}

func newVaultFixture(t *testing.T) *vaultFixture {
	t.Helper()
	f := newBudgetFixture(t)
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET revision=1 WHERE id=$1::uuid;`, connectionID(1)); e != nil {
		t.Fatal(e)
	}
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+vaultFunctions+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	s, e := vault.NewService(f.runtime, f.ring)
	if e != nil {
		t.Fatal(e)
	}
	return &vaultFixture{f, s}
}
func (f *vaultFixture) checkpoint(t *testing.T) vault.Checkpoint {
	t.Helper()
	c, e := f.vault.Inspect(correlation.New(f.base.ctx), f.actor, clientAID, connectionID(1))
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func (f *vaultFixture) replace(t *testing.T, c vault.Checkpoint, secret string) vault.Checkpoint {
	t.Helper()
	n, e := f.vault.Replace(correlation.New(f.base.ctx), f.actor, clientAID, connectionID(1), c, []byte(secret))
	if e != nil {
		t.Fatal(e)
	}
	return n
}
func (f *vaultFixture) stored(t *testing.T, ring *credentials.Keyring) string {
	t.Helper()
	var raw []byte
	if e := f.admin.QueryRow(f.base.ctx, `SELECT envelope FROM app.integration_credentials WHERE connection_id=$1::uuid`, connectionID(1)).Scan(&raw); e != nil {
		t.Fatal(e)
	}
	defer clear(raw)
	envelope, e := credentials.ParseEnvelope(raw)
	if e != nil {
		t.Fatal("stored envelope framing failed")
	}
	secret, e := ring.Open(budgetBinding(clientAID, connectionID(1)), envelope)
	if e != nil {
		t.Fatal("stored envelope authentication failed", e)
	}
	defer clear(secret)
	return string(secret) // Only synthetic test data; never print secrets on failure.
}
func (f *vaultFixture) mutationEvents(t *testing.T) (int, int) {
	t.Helper()
	var credential, connection int
	if e := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FILTER(WHERE resource_kind='integration_credential'),count(*) FILTER(WHERE resource_kind='integration_connection') FROM app.audit_events`).Scan(&credential, &connection); e != nil {
		t.Fatal(e)
	}
	return credential, connection
}

func TestIntegrationVaultReplacementRotationRestartAndSafeProjection(t *testing.T) {
	f := newVaultFixture(t)
	ctx := correlation.New(f.base.ctx)
	c := f.checkpoint(t)
	if c != (vault.Checkpoint{ConnectionRevision: 1, Generation: 1}) {
		t.Fatal("absent checkpoint incorrect")
	}
	if n, e := f.vault.Rewrap(ctx, f.actor, clientAID, connectionID(1), c); e != vault.ErrMissing || n != (vault.Checkpoint{}) {
		t.Fatal("absent credential rotated", e)
	}
	c = f.replace(t, c, "synthetic-old-token")
	if c != (vault.Checkpoint{ConnectionRevision: 2, Generation: 2, CredentialRevision: 1}) || f.stored(t, f.ring) != "synthetic-old-token" {
		t.Fatal("initial persistence or generation failed")
	}
	c = f.replace(t, c, "synthetic-replacement-token")
	rotated, e := credentials.New("synthetic-next", map[string][]byte{"synthetic-primary": bytes.Repeat([]byte{0x6b}, 32), "synthetic-next": bytes.Repeat([]byte{0x7c}, 32)})
	if e != nil {
		t.Fatal(e)
	}
	rebuilt, e := vault.NewService(f.runtime, rotated)
	if e != nil {
		t.Fatal(e)
	}
	next, e := rebuilt.Rewrap(ctx, f.actor, clientAID, connectionID(1), c)
	if e != nil || next != (vault.Checkpoint{ConnectionRevision: 4, Generation: 3, CredentialRevision: 3}) {
		t.Fatal("rotation checkpoint failed", e)
	}
	if f.stored(t, syntheticRing(t, "synthetic-next", 0x7c)) != "synthetic-replacement-token" {
		t.Fatal("rotation changed token")
	}
	restart, e := vault.NewService(f.runtime, syntheticRing(t, "synthetic-next", 0x7c))
	if e != nil {
		t.Fatal(e)
	}
	resumed, e := restart.Inspect(ctx, f.actor, clientAID, connectionID(1))
	if e != nil || resumed != next {
		t.Fatal("restart lost checkpoint", e)
	}
	if n, e := restart.Rewrap(ctx, f.actor, clientAID, connectionID(1), c); e != vault.ErrConflict || n != (vault.Checkpoint{}) {
		t.Fatal("stale rotation resumed", e)
	}
	if count, events := f.accounting(t); count != 3 || events != 3 {
		t.Fatal("rotation accounting incorrect")
	}
	if a, b := f.mutationEvents(t); a != 3 || b != 3 {
		t.Fatal("transactional audits missing")
	}
	var state string
	if e = f.admin.QueryRow(ctx, `SELECT state FROM app.integration_connections WHERE id=$1::uuid`, connectionID(1)).Scan(&state); e != nil || state != "pending" {
		t.Fatal("storage invented provider success")
	}
	// Existing HTTP metadata has exactly its safe projection; no credential fields.
	w := f.request(t, &f.login, "GET", metadataPath(clientAID)+"/"+connectionID(1), nil, nil)
	assertStatus(t, w, 200, "")
	var response struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if e = json.Unmarshal(w.Body.Bytes(), &response); e != nil || len(response.Data) != 7 {
		t.Fatal("metadata projection expanded")
	}
	reader, e := auditreader.NewService(f.runtime)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.admin.Exec(ctx, `GRANT EXECUTE ON FUNCTION app.audit_reader_detail(uuid,uuid,uuid) TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	rows, e := f.admin.Query(ctx, `SELECT id::text,resource_kind,event_name FROM app.audit_events WHERE resource_kind IN ('integration_credential','integration_connection') ORDER BY occurred_at,id`)
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	for rows.Next() {
		var id, kind, event string
		if e = rows.Scan(&id, &kind, &event); e != nil {
			t.Fatal(e)
		}
		detail, e := reader.Detail(ctx, f.actor, clientAID, id)
		if e != nil {
			t.Fatal(e)
		}
		raw, e := json.Marshal(detail)
		if e != nil {
			t.Fatal(e)
		}
		for _, private := range []string{"synthetic-old-token", "synthetic-replacement-token", "synthetic-primary", "synthetic-next", "fingerprint", "envelope", "generation", "provider_account_id"} {
			if bytes.Contains(raw, []byte(private)) || bytes.Contains(w.Body.Bytes(), []byte(private)) || strings.Contains(f.logs.String(), private) {
				t.Fatal("private credential data entered projection")
			}
		}
		if kind == "integration_credential" && event != "integration_credential.created" && event != "integration_credential.updated" {
			t.Fatal("unsafe audit action")
		}
	}
	if e = rows.Err(); e != nil {
		t.Fatal(e)
	}
}

func TestIntegrationVaultInputStaleOverflowAndBudgetDenial(t *testing.T) {
	f := newVaultFixture(t)
	ctx := correlation.New(f.base.ctx)
	c := f.checkpoint(t)
	for _, secret := range [][]byte{nil, make([]byte, credentials.MaxPlaintextBytes+1)} {
		if n, e := f.vault.Replace(ctx, f.actor, clientAID, connectionID(1), c, secret); e != vault.ErrInvalid || n != (vault.Checkpoint{}) {
			t.Fatal("invalid secret accepted", e)
		}
	}
	stale := c
	stale.ConnectionRevision++
	if _, e := f.vault.Replace(ctx, f.actor, clientAID, connectionID(1), stale, []byte("synthetic")); e != vault.ErrConflict {
		t.Fatal("stale preflight accepted", e)
	}
	if _, e := f.admin.Exec(ctx, `UPDATE app.integration_connections SET revision=9223372036854775807 WHERE id=$1::uuid`, connectionID(1)); e != nil {
		t.Fatal(e)
	}
	if _, e := f.vault.Replace(ctx, f.actor, clientAID, connectionID(1), f.checkpoint(t), []byte("synthetic")); e != vault.ErrConflict {
		t.Fatal("revision overflow accepted", e)
	}
	if n, events := f.accounting(t); n != 0 || events != 0 {
		t.Fatal("early denial consumed budget")
	}
	if _, e := f.admin.Exec(ctx, `UPDATE app.integration_connections SET revision=1 WHERE id=$1::uuid`, connectionID(1)); e != nil {
		t.Fatal(e)
	}
	f.seedCount(t, f.ring, 1<<24)
	if n, e := f.vault.Replace(ctx, f.actor, clientAID, connectionID(1), c, []byte("synthetic")); e != vault.ErrExhausted || n != (vault.Checkpoint{}) {
		t.Fatal("quota denial returned success", e)
	}
	if f.checkpoint(t) != c {
		t.Fatal("quota failure changed metadata")
	}
}

// Test-only barrier before the real writer takes its exclusive lifecycle lock.
// Every fixture owns a separate disposable database; no production hooks.
func (f *vaultFixture) blockWrite(t *testing.T, ctx context.Context) pgx.Tx {
	t.Helper()
	if _, e := f.admin.Exec(ctx, `ALTER FUNCTION app.integration_credential_write(uuid,uuid,uuid,bigint,bigint,bigint,text,bytea,bytea,boolean) RENAME TO integration_credential_write_original;
 CREATE FUNCTION app.integration_credential_write(actor uuid,client uuid,connection uuid,expected_connection bigint,expected_generation bigint,expected_credential bigint,label text,digest bytea,data bytea,rewrap boolean)
 RETURNS TABLE(connection_revision bigint,connection_generation bigint,credential_revision bigint)
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(871092650210);
 RETURN QUERY SELECT * FROM app.integration_credential_write_original(actor,client,connection,expected_connection,expected_generation,expected_credential,label,digest,data,rewrap); END $$;
 REVOKE EXECUTE ON FUNCTION app.integration_credential_write(uuid,uuid,uuid,bigint,bigint,bigint,text,bytea,bytea,boolean) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION app.integration_credential_write(uuid,uuid,uuid,bigint,bigint,bigint,text,bytea,bytea,boolean) TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	tx, e := f.admin.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650210)`); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx
}
func waitVaultWriters(t *testing.T, ctx context.Context, pool *pgxpool.Pool, n int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var count int
		if e := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`).Scan(&count); e != nil {
			t.Fatal(e)
		}
		if count >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("writer did not reach storage barrier")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestIntegrationVaultConcurrentReplacementAndRotationCannotOverwrite(t *testing.T) {
	for _, rotation := range []bool{false, true} {
		t.Run(fmt.Sprint(rotation), func(t *testing.T) {
			f := newVaultFixture(t)
			ctx := correlation.New(f.base.ctx)
			c := f.checkpoint(t)
			if rotation {
				c = f.replace(t, c, "synthetic-initial")
			}
			blocker := f.blockWrite(t, ctx)
			type answer struct {
				c      vault.Checkpoint
				e      error
				secret string
			}
			results := make(chan answer, 2)
			go func() {
				n, e := f.vault.Replace(ctx, f.actor, clientAID, connectionID(1), c, []byte("synthetic-new"))
				results <- answer{n, e, "synthetic-new"}
			}()
			go func() {
				if rotation {
					n, e := f.vault.Rewrap(ctx, f.actor, clientAID, connectionID(1), c)
					results <- answer{n, e, "synthetic-initial"}
				} else {
					n, e := f.vault.Replace(ctx, f.actor, clientAID, connectionID(1), c, []byte("synthetic-other"))
					results <- answer{n, e, "synthetic-other"}
				}
			}()
			waitVaultWriters(t, ctx, f.adminPool, 2)
			if e := blocker.Commit(ctx); e != nil {
				t.Fatal(e)
			}
			success := 0
			for i := 0; i < 2; i++ {
				a := <-results
				if a.e == nil {
					success++
					if f.checkpoint(t) != a.c || f.stored(t, f.ring) != a.secret {
						t.Fatal("winner overwritten by stale ciphertext")
					}
				} else if a.e != vault.ErrConflict || a.c != (vault.Checkpoint{}) {
					t.Fatal("losing write returned result", a.e)
				}
			}
			if success != 1 {
				t.Fatal("CAS allowed multiple writers")
			}
			expected := 2
			if rotation {
				expected = 3
			}
			if n, events := f.accounting(t); n != int64(expected) || events != expected {
				t.Fatal("stale storage refunded encryption capacity")
			}
			expected--
			if a, b := f.mutationEvents(t); a != expected || b != expected {
				t.Fatal("losing CAS left partial audit")
			}
		})
	}
}

func TestIntegrationVaultPostEncryptionDenialAndAuditFailure(t *testing.T) {
	for _, scenario := range []string{"revocation", "disabled", "archive", "disconnect", "generation", "credential revision", "audit", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			f := newVaultFixture(t)
			ctx, cancel := context.WithTimeout(correlation.New(f.base.ctx), 8*time.Second)
			defer cancel()
			actor, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage}, clientAID)
			c := f.checkpoint(t)
			if scenario == "credential revision" {
				c = f.replace(t, c, "synthetic-original")
			}
			blocker := f.blockWrite(t, ctx)
			type answer struct {
				c vault.Checkpoint
				e error
			}
			answers := make(chan answer, 1)
			go func() {
				n, e := f.vault.Replace(ctx, actor, clientAID, connectionID(1), c, []byte("synthetic-do-not-publish"))
				answers <- answer{n, e}
			}()
			waitVaultWriters(t, ctx, f.adminPool, 1)
			var e error
			expected := vault.ErrMissing
			if scenario == "cancel" {
				cancel()
				a := <-answers
				if a.e != vault.ErrUnavailable || a.c != (vault.Checkpoint{}) {
					t.Fatal("canceled storage returned result", a.e)
				}
				_ = blocker.Rollback(f.base.ctx)
			} else {
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
				case "disabled":
					_, e = tx.Exec(ctx, `UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, actor)
				case "archive":
					_, e = tx.Exec(ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID)
				case "disconnect":
					_, e = tx.Exec(ctx, `UPDATE app.integration_connections SET state='disconnect_pending',revision=revision+1,generation=generation+1 WHERE id=$1::uuid`, connectionID(1))
				case "generation":
					expected = vault.ErrConflict
					_, e = tx.Exec(ctx, `UPDATE app.integration_connections SET generation=generation+1 WHERE id=$1::uuid`, connectionID(1))
				case "credential revision":
					expected = vault.ErrConflict
					_, e = tx.Exec(ctx, `UPDATE app.integration_credentials SET revision=revision+1 WHERE connection_id=$1::uuid`, connectionID(1))
				case "audit":
					expected = vault.ErrUnavailable
					_, e = tx.Exec(ctx, `REVOKE INSERT `+auditColumns+` ON app.audit_events FROM `+f.runtimeRole)
				}
				if e != nil {
					t.Fatal(e)
				}
				if e = tx.Commit(ctx); e != nil {
					t.Fatal(e)
				}
				if e = blocker.Commit(ctx); e != nil {
					t.Fatal(e)
				}
				a := <-answers
				if a.e != expected || a.c != (vault.Checkpoint{}) {
					t.Fatal("fresh storage fence ignored", a.e)
				}
			}
			want := 1
			if scenario == "credential revision" {
				want = 2
				if f.stored(t, f.ring) != "synthetic-original" {
					t.Fatal("stale row replaced")
				}
			}
			if n, events := f.accounting(t); n != int64(want) || events != want {
				t.Fatal("post-encryption failure refunded capacity")
			}
			want--
			if a, b := f.mutationEvents(t); a != want || b != want {
				t.Fatal("failed storage left audit")
			}
			var count int
			if e = f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.integration_credentials`).Scan(&count); e != nil || count != want {
				t.Fatal("failed storage left ciphertext")
			}
			var revision int64
			if e = f.admin.QueryRow(f.base.ctx, `SELECT revision FROM app.integration_connections WHERE id=$1::uuid`, connectionID(1)).Scan(&revision); e != nil {
				t.Fatal(e)
			}
			wantRevision := int64(1)
			if scenario == "disconnect" || scenario == "credential revision" {
				wantRevision = 2
			}
			if revision != wantRevision {
				t.Fatal("failed storage changed metadata")
			}
		})
	}
}

func TestIntegrationVaultDeferredCommitFailureTamperingAndOneConnectionPool(t *testing.T) {
	f := newVaultFixture(t)
	ctx := correlation.New(f.base.ctx)
	c := f.checkpoint(t)
	if _, e := f.admin.Exec(ctx, `CREATE FUNCTION app.test_vault_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='synthetic-private-commit-failure'; END $$;
 CREATE CONSTRAINT TRIGGER test_vault_commit_failure AFTER INSERT OR UPDATE ON app.integration_credentials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.test_vault_commit_failure()`); e != nil {
		t.Fatal(e)
	}
	if n, e := f.vault.Replace(ctx, f.actor, clientAID, connectionID(1), c, []byte("synthetic")); e != vault.ErrUnavailable || n != (vault.Checkpoint{}) {
		t.Fatal("failed commit returned success", e)
	}
	if f.checkpoint(t) != c {
		t.Fatal("failed commit changed checkpoint")
	}
	if n, events := f.accounting(t); n != 1 || events != 1 {
		t.Fatal("failed storage commit refunded reservation")
	}
	if a, b := f.mutationEvents(t); a != 0 || b != 0 {
		t.Fatal("commit failure left partial audits")
	}
	if _, e := f.admin.Exec(ctx, `DROP TRIGGER test_vault_commit_failure ON app.integration_credentials; DROP FUNCTION app.test_vault_commit_failure()`); e != nil {
		t.Fatal(e)
	}
	config := f.runtime.Config().Copy()
	config.MaxConns = 1
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	service, e := vault.NewService(pool, f.ring)
	if e != nil {
		t.Fatal(e)
	}
	c, e = service.Replace(ctx, f.actor, clientAID, connectionID(1), c, []byte("synthetic"))
	if e != nil {
		t.Fatal("sequential transactions exhausted pool", e)
	}
	// Authorized owner fixture tampers with the authentication tag, preserving framing.
	if _, e = f.admin.Exec(ctx, `UPDATE app.integration_credentials SET envelope=set_byte(envelope,octet_length(envelope)-1,get_byte(envelope,octet_length(envelope)-1)#1),revision=revision+1 WHERE connection_id=$1::uuid`, connectionID(1)); e != nil {
		t.Fatal(e)
	}
	c = f.checkpoint(t)
	if n, e := service.Rewrap(ctx, f.actor, clientAID, connectionID(1), c); e != vault.ErrUnavailable || n != (vault.Checkpoint{}) {
		t.Fatal("tampered credential rotated", e)
	}
	if f.checkpoint(t) != c {
		t.Fatal("tampered rewrap changed checkpoint")
	}
	if n, events := f.accounting(t); n != 3 || events != 3 {
		t.Fatal("failed authentication refunded capacity")
	}
	if a, b := f.mutationEvents(t); a != 1 || b != 1 {
		t.Fatal("failed authentication left audit")
	}
	// A fresh verified replacement can recover an authenticated-row failure.
	c, e = service.Replace(ctx, f.actor, clientAID, connectionID(1), c, []byte("synthetic-recovered"))
	if e != nil {
		t.Fatal(e)
	}
	if f.stored(t, f.ring) != "synthetic-recovered" {
		t.Fatal("replacement recovery failed")
	}
	pool.Close()
	if n, e := service.Inspect(ctx, f.actor, clientAID, connectionID(1)); e != vault.ErrUnavailable || n != (vault.Checkpoint{}) {
		t.Fatal("closed pool returned data", e)
	}
}

func TestIntegrationVaultExactPermissionsOwnershipStateAndOldGeneration(t *testing.T) {
	for _, permissions := range [][]authorization.Permission{{authorization.ClientsView}, {authorization.IntegrationsManage}, {authorization.ClientsView, authorization.IntegrationsView, authorization.AnalyticsView}, {authorization.ClientsView, authorization.IntegrationsManage}} {
		t.Run(fmt.Sprint(permissions), func(t *testing.T) {
			f := newVaultFixture(t)
			ctx := correlation.New(f.base.ctx)
			c := f.replace(t, f.checkpoint(t), "synthetic")
			actor, _ := f.grant(t, permissions, clientAID)
			allowed := len(permissions) == 2 && permissions[1] == authorization.IntegrationsManage
			_, e := f.vault.Inspect(ctx, actor, clientAID, connectionID(1))
			if allowed {
				if e != nil {
					t.Fatal(e)
				}
			} else if e != vault.ErrMissing {
				t.Fatal("implicit management granted", e)
			}
			for _, target := range []struct{ client, connection string }{{clientBID, connectionID(1)}, {clientAID, connectionID(2)}} {
				if n, e := f.vault.Inspect(ctx, actor, target.client, target.connection); e != vault.ErrMissing || n != (vault.Checkpoint{}) {
					t.Fatal("foreign/missing credential exposed", e)
				}
				if _, e := f.vault.Replace(ctx, actor, target.client, target.connection, c, []byte("synthetic")); e != vault.ErrMissing {
					t.Fatal("foreign write allowed", e)
				}
				if _, e := f.vault.Rewrap(ctx, actor, target.client, target.connection, c); e != vault.ErrMissing {
					t.Fatal("foreign rewrap allowed", e)
				}
			}
			if !allowed {
				if _, e := f.vault.Replace(ctx, actor, clientAID, connectionID(1), c, []byte("synthetic")); e != vault.ErrMissing {
					t.Fatal(e)
				}
				if _, e := f.vault.Rewrap(ctx, actor, clientAID, connectionID(1), c); e != vault.ErrMissing {
					t.Fatal(e)
				}
			}
			if n, events := f.accounting(t); n != 1 || events != 1 {
				t.Fatal("denied request spent capacity")
			}
		})
	}
	f := newVaultFixture(t)
	ctx := correlation.New(f.base.ctx)
	c := f.replace(t, f.checkpoint(t), "synthetic")
	for _, state := range []string{"pending", "connected", "reauthorization_required", "disconnect_pending", "revocation_failed", "disconnected"} {
		if _, e := f.admin.Exec(ctx, `UPDATE app.integration_connections SET state=$1 WHERE id=$2::uuid`, state, connectionID(1)); e != nil {
			t.Fatal(e)
		}
		allowed := state == "pending" || state == "connected" || state == "reauthorization_required"
		_, e := f.vault.Inspect(ctx, f.actor, clientAID, connectionID(1))
		if allowed {
			if e != nil {
				t.Fatal(e)
			}
		} else {
			if e != vault.ErrMissing {
				t.Fatal("disconnected storage readable", e)
			}
			if _, e = f.vault.Replace(ctx, f.actor, clientAID, connectionID(1), c, []byte("synthetic")); e != vault.ErrMissing {
				t.Fatal(e)
			}
			if _, e = f.vault.Rewrap(ctx, f.actor, clientAID, connectionID(1), c); e != vault.ErrMissing {
				t.Fatal(e)
			}
		}
	}
	if _, e := f.admin.Exec(ctx, `UPDATE app.integration_connections SET state='pending',generation=generation+1 WHERE id=$1::uuid`, connectionID(1)); e != nil {
		t.Fatal(e)
	}
	c = f.checkpoint(t)
	if _, e := f.vault.Rewrap(ctx, f.actor, clientAID, connectionID(1), c); e != vault.ErrConflict {
		t.Fatal("obsolete token generation reactivated", e)
	}
	c = f.replace(t, c, "synthetic-new-generation")
	if f.stored(t, f.ring) != "synthetic-new-generation" {
		t.Fatal("fresh replacement could not supersede obsolete generation")
	}
	if _, e := f.admin.Exec(ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientAID); e != nil {
		t.Fatal(e)
	}
	if _, e := f.vault.Inspect(ctx, f.actor, clientAID, connectionID(1)); e != vault.ErrMissing {
		t.Fatal("archived client credential readable", e)
	}
	if _, e := f.vault.Replace(ctx, f.actor, clientAID, connectionID(1), c, []byte("synthetic")); e != vault.ErrMissing {
		t.Fatal(e)
	}
	if n, events := f.accounting(t); n != 2 || events != 2 {
		t.Fatal("local disabled use consumed budget")
	}
}

func TestIntegrationVaultQueuedRevocationAndReadLockRetention(t *testing.T) {
	for _, permission := range []string{"clients.view", "integrations.manage"} {
		t.Run(permission, func(t *testing.T) {
			f := newVaultFixture(t)
			ctx := correlation.New(f.base.ctx)
			actor, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage}, clientAID)
			tx, e := f.admin.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback(ctx)
			if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); e != nil {
				t.Fatal(e)
			}
			if _, e = tx.Exec(ctx, `UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id=(SELECT role_id FROM app.user_roles WHERE id=$1::uuid) AND permission_key=$2`, assignment, permission); e != nil {
				t.Fatal(e)
			}
			answers := make(chan error, 1)
			go func() {
				c, e := f.vault.Inspect(ctx, actor, clientAID, connectionID(1))
				if c != (vault.Checkpoint{}) {
					answers <- fmt.Errorf("stale read returned checkpoint")
					return
				}
				answers <- e
			}()
			waitBudgetLock(t, ctx, f.adminPool)
			if e = tx.Commit(ctx); e != nil {
				t.Fatal(e)
			}
			if e = <-answers; e != vault.ErrMissing {
				t.Fatal("queued read retained old permission", e)
			}
		})
	}
	f := newVaultFixture(t)
	ctx := correlation.New(f.base.ctx)
	tx, e := f.runtime.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT * FROM app.integration_credential_read($1::uuid,$2::uuid,$3::uuid)`, f.actor, clientAID, connectionID(1)); e != nil {
		t.Fatal(e)
	}
	writer, e := f.admin.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer writer.Rollback(ctx)
	answers := make(chan error, 1)
	go func() { _, e := writer.Exec(ctx, `SELECT pg_advisory_xact_lock(871092650209)`); answers <- e }()
	waitBudgetLock(t, ctx, f.adminPool)
	select {
	case e := <-answers:
		t.Fatal("writer bypassed credential read transaction", e)
	default:
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = <-answers; e != nil {
		t.Fatal(e)
	}
}

func TestIntegrationVaultRuntimeSchemaAndRetainedRollback(t *testing.T) {
	f := newVaultFixture(t)
	ctx := correlation.New(f.base.ctx)
	f.replace(t, f.checkpoint(t), "synthetic")
	for _, sql := range []string{`SELECT * FROM app.integration_credentials`, `INSERT INTO app.integration_credentials SELECT * FROM app.integration_credentials`, `UPDATE app.integration_credentials SET revision=revision+1`, `DELETE FROM app.integration_credentials`, `TRUNCATE app.integration_credentials`, `SELECT app.integration_credential_guard()`, `SELECT app.integration_credential_envelope_valid(NULL,NULL)`} {
		if _, e := f.runtime.Exec(ctx, sql); e == nil {
			t.Fatal("runtime private boundary bypassed")
		}
	}
	for _, sql := range []string{`UPDATE app.integration_credentials SET revision=0`, `UPDATE app.integration_credentials SET revision=revision+2`, `UPDATE app.integration_credentials SET purpose='refresh_token',revision=revision+1`, `UPDATE app.integration_credentials SET generation=0,revision=revision+1`, `UPDATE app.integration_credentials SET envelope=decode('01','hex'),revision=revision+1`, `UPDATE app.integration_credentials SET envelope=decode(repeat('00',16479),'hex'),revision=revision+1`, `UPDATE app.integration_credentials SET envelope=set_byte(envelope,0,2),revision=revision+1`, `UPDATE app.integration_credentials SET envelope=set_byte(envelope,1,64),revision=revision+1`, `UPDATE app.integration_credentials SET envelope=set_byte(envelope,2,120),revision=revision+1`, `UPDATE app.integration_credentials SET key_id=gen_random_uuid(),revision=revision+1`, `UPDATE app.integration_credentials SET created_at=created_at+interval '1 second',revision=revision+1`, `UPDATE app.integration_credentials SET updated_at='infinity',revision=revision+1`, `UPDATE app.integration_credentials SET updated_at=created_at-interval '1 second',revision=revision+1`, `DELETE FROM app.integration_credentials`, `TRUNCATE app.integration_credentials`} {
		if _, e := f.admin.Exec(ctx, sql); e == nil {
			t.Fatal("invalid credential DML accepted")
		}
	}
	role, url := f.base.role(t)
	if _, e := f.admin.Exec(ctx, `GRANT USAGE ON SCHEMA app TO `+pgx.Identifier{role}.Sanitize()); e != nil {
		t.Fatal(e)
	}
	pool, e := pgxpool.New(ctx, url)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	for _, fn := range strings.Split(vaultFunctions, ",app.") {
		if !strings.HasPrefix(fn, "app.") {
			fn = "app." + fn
		}
		var allowed, secure bool
		if e = pool.QueryRow(ctx, `SELECT has_function_privilege(current_user,$1,'EXECUTE')`, fn).Scan(&allowed); e != nil || allowed {
			t.Fatal("PUBLIC vault entrypoint exposed", e)
		}
		if e = f.admin.QueryRow(ctx, `SELECT prosecdef AND provolatile='v' AND lower(array_to_string(proconfig,',')) LIKE '%search_path=pg_catalog%' AND lower(array_to_string(proconfig,',')) LIKE '%timezone=utc%' FROM pg_proc WHERE oid=$1::regprocedure`, fn).Scan(&secure); e != nil || !secure {
			t.Fatal("unsafe credential definer", e)
		}
	}
	for _, fn := range []string{"app.integration_credential_guard()", "app.integration_credential_envelope_valid(bytea,text)"} {
		var allowed bool
		if e = pool.QueryRow(ctx, `SELECT has_function_privilege(current_user,$1,'EXECUTE')`, fn).Scan(&allowed); e != nil || allowed {
			t.Fatal("PUBLIC credential helper exposed", e)
		}
	}
	if _, e = provider(t, f.base).DownTo(ctx, 16); e == nil {
		t.Fatal("populated credential rollback allowed")
	}
	if f.stored(t, f.ring) != "synthetic" {
		t.Fatal("refused rollback lost stored credential")
	}
}

func TestIntegrationVaultEmptyRollbackRegrantAndAuditOnlyHistory(t *testing.T) {
	f := newVaultFixture(t)
	ctx := correlation.New(f.base.ctx)
	p := provider(t, f.base)
	c := f.checkpoint(t)
	// Existing budget history must survive migration 17's empty rollback.
	f.seedCount(t, f.ring, 1)
	if _, e := p.DownTo(ctx, 16); e != nil {
		t.Fatal(e)
	}
	if n, events := f.accounting(t); n != 1 || events != 0 {
		t.Fatal("credential rollback destroyed accounting")
	}
	if _, e := p.Up(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e := f.vault.Inspect(ctx, f.actor, clientAID, connectionID(1)); e != vault.ErrUnavailable {
		t.Fatal("recreated functions retained grants", e)
	}
	if _, e := f.admin.Exec(ctx, `GRANT EXECUTE ON FUNCTION `+vaultFunctions+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	f.replace(t, c, "synthetic")
	other := newVaultFixture(t)
	if _, e := other.runtime.Exec(other.base.ctx, `INSERT INTO app.audit_events `+auditColumns+` VALUES('user',$1::uuid,'integration_credential.created','integration_credential',$2::uuid,$3::uuid,$4,'{"exists":false}','{"exists":true,"revision":1}','{"source":"cli"}')`, other.actor, connectionID(1), clientAID, correlation.ID(correlation.New(other.base.ctx))); e != nil {
		t.Fatal(e)
	}
	if _, e := provider(t, other.base).DownTo(other.base.ctx, 16); e == nil {
		t.Fatal("audit-only credential history rollback allowed")
	}
}
