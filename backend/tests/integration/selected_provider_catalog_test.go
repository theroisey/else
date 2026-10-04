//go:build integration

package integration

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/catalog"
	"github.com/theroisey/else/backend/internal/integrations/connections"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
	"github.com/theroisey/else/backend/internal/integrations/inventory"
	"github.com/theroisey/else/backend/internal/integrations/rotation"
	"github.com/theroisey/else/backend/internal/integrations/vault"
)

func selectedCatalogFixture(t *testing.T, provider string) (*vaultFixture, string) {
	t.Helper()
	f := newDisconnectFixture(t)
	id := connectionID(1)
	if provider != "meta_ads" {
		id = connectionID(2)
		account := "123456789"
		if provider == "woocommerce" {
			account = "https://shop.example.com/store"
		}
		if _, err := f.admin.Exec(f.base.ctx, `INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES($1,$2,$3,$4)`, id, clientAID, provider, account); err != nil {
			t.Fatal("selected synthetic connection seed failed")
		}
	}
	return f, id
}

func assertSelectedCiphertext(t *testing.T, f *vaultFixture, id, provider string, ring *credentials.Keyring) {
	t.Helper()
	var raw []byte
	var purpose string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT envelope,purpose FROM app.integration_credentials WHERE connection_id=$1`, id).Scan(&raw, &purpose); err != nil {
		t.Fatal("selected stored credential missing")
	}
	defer clear(raw)
	expected, _ := catalog.CredentialPurpose(provider)
	if purpose != expected {
		t.Fatal("stored provider purpose mismatch")
	}
	envelope, err := credentials.ParseEnvelope(raw)
	if err != nil {
		t.Fatal("selected envelope invalid")
	}
	binding := credentials.Binding{ClientID: clientAID, ConnectionID: id, Provider: provider, Purpose: purpose}
	plain, err := ring.Open(binding, envelope)
	if err != nil || !bytes.Equal(plain, []byte("synthetic-selected-credential")) {
		clear(plain)
		t.Fatal("selected retained ciphertext failed authentication")
	}
	clear(plain)
	for _, other := range []string{"meta_ads", "ga4", "woocommerce"} {
		if other == provider {
			continue
		}
		wrong := binding
		wrong.Provider = other
		wrong.Purpose, _ = catalog.CredentialPurpose(other)
		if plain, err := ring.Open(wrong, envelope); plain != nil || err != credentials.ErrOpen {
			clear(plain)
			t.Fatal("stored cross-provider ciphertext authenticated")
		}
	}
}

func TestSelectedProviderCredentialLifecyclePrivacyAndFreshAuthorization(t *testing.T) {
	for _, providerName := range []string{"meta_ads", "ga4", "woocommerce"} {
		t.Run(providerName, func(t *testing.T) {
			f, id := selectedCatalogFixture(t, providerName)
			ctx := correlation.New(f.base.ctx)
			checkpoint, err := f.vault.Inspect(ctx, f.actor, clientAID, id)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.vault.Inspect(ctx, f.actor, clientBID, id); err != vault.ErrMissing {
				t.Fatal("cross-client credential visible")
			}
			user, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsView, authorization.IntegrationsManage}, clientAID)
			if _, err := f.vault.Inspect(ctx, user, clientAID, id); err != nil {
				t.Fatal("exact-client grant rejected")
			}
			if err := f.authorizer.RevokeRole(ctx, f.actor, assignment); err != nil {
				t.Fatal(err)
			}
			if _, err := f.vault.Replace(ctx, user, clientAID, id, checkpoint, []byte("synthetic-selected-credential")); err != vault.ErrMissing {
				t.Fatal("revoked actor stored credential")
			}
			if count, events := f.accounting(t); count != 0 || events != 0 {
				t.Fatal("revoked actor consumed reservation")
			}
			next, err := f.vault.Replace(ctx, f.actor, clientAID, id, checkpoint, []byte("synthetic-selected-credential"))
			if err != nil || next != (vault.Checkpoint{ConnectionRevision: 2, Generation: 2, CredentialRevision: 1}) {
				t.Fatal("selected credential write failed", err)
			}
			assertSelectedCiphertext(t, f, id, providerName, f.ring)
			if _, err := f.vault.Replace(ctx, f.actor, clientAID, id, checkpoint, []byte("synthetic-selected-credential")); err != vault.ErrConflict {
				t.Fatal("stale selected credential accepted")
			}
			w := f.request(t, &f.login, "GET", metadataPath(clientAID)+"/"+id, nil, nil)
			assertStatus(t, w, 200, "")
			var projected struct{ Data map[string]json.RawMessage }
			if json.Unmarshal(w.Body.Bytes(), &projected) != nil || len(projected.Data) != 7 || string(projected.Data["provider"]) != `"`+providerName+`"` || string(projected.Data["state"]) != `"pending"` {
				t.Fatal("selected safe metadata changed")
			}
			var auditRaw string
			if f.admin.QueryRow(ctx, `SELECT coalesce(string_agg(to_jsonb(e)::text,''),'') FROM app.audit_events e WHERE resource_kind IN ('integration_credential','integration_connection','integration_encryption')`).Scan(&auditRaw) != nil {
				t.Fatal("selected audit unavailable")
			}
			for _, private := range []string{"synthetic-selected-credential", "shop.example.com", "123456789", "provider_account_id", "envelope", "synthetic-primary", "fingerprint", "generation"} {
				if bytes.Contains(w.Body.Bytes(), []byte(private)) || strings.Contains(auditRaw, private) || strings.Contains(f.logs.String(), private) {
					t.Fatal("selected private data entered projection/log/audit")
				}
			}
			for _, sql := range []string{"SELECT provider_account_id FROM app.integration_connections", "SELECT envelope FROM app.integration_credentials", "SELECT app.integration_account_valid('ga4','1')", "INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES(gen_random_uuid(),'" + clientAID + "','ga4','999')"} {
				if _, err := f.runtime.Exec(ctx, sql); err == nil {
					t.Fatal("runtime acquired private catalog privilege")
				}
			}
			// Existing ciphertext/purpose/revision are immutable even for owner DML.
			if _, err := f.admin.Exec(ctx, `UPDATE app.integration_credentials SET purpose='other',revision=revision+1 WHERE connection_id=$1`, id); err == nil {
				t.Fatal("owner changed credential purpose")
			}
			if _, err := f.admin.Exec(ctx, `UPDATE app.integration_connections SET provider='ga4',provider_account_id='222' WHERE id=$1`, id); err == nil {
				t.Fatal("owner changed connection identity")
			}
			if _, err := f.admin.Exec(ctx, `GRANT EXECUTE ON FUNCTION `+rotationFunction+`,`+inventoryFunction+` TO `+f.runtimeRole); err != nil {
				t.Fatal(err)
			}
			rotatedRing := retainedRing(t, "synthetic-fresh", 0x6b)
			grantPreflight(t, f.budgetFixture)
			observer, err := inventory.NewService(f.runtime, rotatedRing)
			if err != nil {
				t.Fatal(err)
			}
			counts, err := observer.Observe(ctx, f.actor, false)
			if err != nil || len(counts) != 2 || counts[1].StoredRows != "1" || counts[1].EligibleRows != "1" {
				t.Fatal("selected inventory eligibility incorrect", err)
			}
			rotator, err := rotation.NewService(f.runtime, rotatedRing)
			if err != nil {
				t.Fatal(err)
			}
			result, err := rotator.Run(ctx, f.actor, clientAID, "", 100)
			if err != nil || result.Rewrapped != 1 || result.ResumeAfter != id || !result.PageComplete || result.More {
				t.Fatal("selected rotation failed", err)
			}
			assertSelectedCiphertext(t, f, id, providerName, rotatedRing)
			counts, err = observer.Observe(ctx, f.actor, false)
			if err != nil || counts[0].StoredRows != "1" || counts[0].EligibleRows != "0" || counts[1].StoredRows != "0" {
				t.Fatal("selected rotation inventory did not advance")
			}
			before, err := f.vault.Inspect(ctx, f.actor, clientAID, id)
			if err != nil {
				t.Fatal(err)
			}
			assertStatus(t, f.request(t, &f.login, "POST", disconnectPath(clientBID, id), disconnectBody("3"), nil), 404, "not_found")
			assertStatus(t, f.request(t, &f.login, "POST", disconnectPath(clientAID, id), disconnectBody("2"), nil), 409, "conflict")
			w = f.request(t, &f.login, "POST", disconnectPath(clientAID, id), disconnectBody("3"), nil)
			assertStatus(t, w, 200, "")
			var disabled connections.DisconnectResult
			if json.Unmarshal(w.Body.Bytes(), &disabled) != nil || disabled.Data.Provider != providerName || disabled.Data.State != "revocation_failed" || disabled.Revocation.Status != "unavailable" || !disabled.Revocation.ManualActionRequired {
				t.Fatal("selected disconnect implied remote success")
			}
			assertSelectedCiphertext(t, f, id, providerName, rotatedRing)
			if _, err := f.vault.Rewrap(ctx, f.actor, clientAID, id, before); err != vault.ErrMissing {
				t.Fatal("locally disabled selected credential still rotates")
			}
			assertStatus(t, f.request(t, &f.login, "POST", disconnectPath(clientAID, id), disconnectBody("4"), nil), 200, "")
			if credentials, connections := f.mutationEvents(t); credentials != 2 || connections != 3 {
				t.Fatal("selected lifecycle audits incorrect")
			}
			if _, err := f.admin.Exec(ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, clientAID); err != nil {
				t.Fatal(err)
			}
			if _, err := f.vault.Inspect(ctx, f.actor, clientAID, id); err != vault.ErrMissing {
				t.Fatal("archived selected credential visible")
			}
			assertStatus(t, f.request(t, &f.login, "POST", disconnectPath(clientAID, id), disconnectBody("4"), nil), 404, "not_found")
		})
	}
}

func TestSelectedProviderIdentityConstraintsAndWrongPurposeInsert(t *testing.T) {
	f, id := selectedCatalogFixture(t, "ga4")
	for _, item := range []struct {
		provider, account string
		valid             bool
	}{
		{"meta_ads", "1", true}, {"meta_ads", strings.Repeat("9", 32), true}, {"ga4", strings.Repeat("9", 20), true},
		{"woocommerce", "https://shop.example.com", true}, {"woocommerce", "https://xn--bcher-kva.example.com/store_1/catalog-2", true},
		{"meta_ads", "01", false}, {"meta_ads", strings.Repeat("9", 33), false}, {"ga4", "0", false}, {"ga4", "properties/123", false}, {"ga4", strings.Repeat("9", 21), false}, {"other", "1", false},
		{"woocommerce", "http://shop.example.com", false}, {"woocommerce", "https://Shop.example.com", false}, {"woocommerce", "https://shop.example.com/", false}, {"woocommerce", "https://user:secret@shop.example.com", false}, {"woocommerce", "https://shop.example.com:443", false}, {"woocommerce", "https://127.0.0.1", false}, {"woocommerce", "https://[::1]", false}, {"woocommerce", "https://localhost", false}, {"woocommerce", "https://shop.example.com?token=value", false}, {"woocommerce", "https://shop.example.com/#x", false}, {"woocommerce", "https://shop.example.com/a%2fb", false}, {"woocommerce", "https://shop.example.com/a/../b", false}, {"woocommerce", "https://-shop.example.com", false}, {"woocommerce", "https://shop..example.com", false}, {"woocommerce", "https://" + strings.Repeat("a", 64) + ".com", false}, {"woocommerce", "https://shop.example.com/" + strings.Repeat("x", 256), false},
	} {
		var valid bool
		if f.admin.QueryRow(f.base.ctx, `SELECT app.integration_account_valid($1,$2)`, item.provider, item.account).Scan(&valid) != nil || valid != item.valid {
			t.Fatal("catalog identity policy mismatch")
		}
		// Exercise the actual table constraint in an isolated rolled-back insert.
		tx, err := f.admin.Begin(f.base.ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, err = tx.Exec(f.base.ctx, `INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES(gen_random_uuid(),$1,$2,$3)`, clientBID, item.provider, item.account)
		_ = tx.Rollback(f.base.ctx)
		if (err == nil) != item.valid {
			t.Fatal("catalog table accepted/rejected identity incorrectly")
		}
	}
	// Framing and committed budget alone cannot store a Meta-purpose envelope
	// for a GA4 connection, even through migration-owner DML.
	result, err := f.budget.Seal(correlation.New(f.base.ctx), f.actor, clientAID, id, []byte("synthetic-selected-credential"))
	if err != nil {
		t.Fatal(err)
	}
	label, digest, _ := f.ring.ActiveKeyIdentity()
	raw := result.Envelope.Binary()
	defer clear(raw)
	if _, err := f.admin.Exec(f.base.ctx, `INSERT INTO app.integration_credentials(connection_id,purpose,key_id,envelope,revision,generation) SELECT $1,'access_token',id,$2,1,1 FROM app.integration_encryption_keys WHERE key_label=$3 AND fingerprint=$4`, id, raw, label, digest[:]); err == nil {
		t.Fatal("wrong provider purpose inserted")
	}
}

func TestSelectedProviderMigrationRetainedHistoryAndMetaCompatibility(t *testing.T) {
	for _, providerName := range []string{"meta_ads", "ga4", "woocommerce"} {
		t.Run(providerName, func(t *testing.T) {
			f, id := selectedCatalogFixture(t, providerName)
			checkpoint, err := f.vault.Inspect(correlation.New(f.base.ctx), f.actor, clientAID, id)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.vault.Replace(correlation.New(f.base.ctx), f.actor, clientAID, id, checkpoint, []byte("synthetic-selected-credential")); err != nil {
				t.Fatal(err)
			}
			before := recoveryFingerprints(t, f.base.ctx, f.admin)
			p := provider(t, f.base)
			var functionPolicy string
			if f.admin.QueryRow(f.base.ctx, `SELECT md5(string_agg(p.oid::regprocedure::text||p.proowner::text||p.prosecdef::text||coalesce(p.proconfig::text,'')||coalesce(p.proacl::text,'')||p.prosrc,'' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'integration_%'`).Scan(&functionPolicy) != nil {
				t.Fatal("private function policy unavailable")
			}
			_, err = p.DownTo(f.base.ctx, 21)
			if providerName != "meta_ads" {
				if err == nil || !reflect.DeepEqual(before, recoveryFingerprints(t, f.base.ctx, f.admin)) {
					t.Fatal("selected downgrade lost retained history")
				}
			} else {
				if err != nil {
					t.Fatal("Meta-only catalog downgrade refused", err)
				}
				assertSelectedCiphertext(t, f, id, providerName, f.ring)
				if _, err := f.vault.Inspect(correlation.New(f.base.ctx), f.actor, clientAID, id); err != nil {
					t.Fatal("Meta legacy grants/binding lost")
				}
				if _, err := p.Up(f.base.ctx); err != nil {
					t.Fatal(err)
				}
				assertSelectedCiphertext(t, f, id, providerName, f.ring)
				var restoredPolicy string
				if f.admin.QueryRow(f.base.ctx, `SELECT md5(string_agg(p.oid::regprocedure::text||p.proowner::text||p.prosecdef::text||coalesce(p.proconfig::text,'')||coalesce(p.proacl::text,'')||p.prosrc,'' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'integration_%'`).Scan(&restoredPolicy) != nil || restoredPolicy != functionPolicy {
					t.Fatal("catalog roundtrip changed function source/owner/security/ACL policy")
				}
			}
		})
	}
}

func TestSelectedProviderAuditFailurePreservesCiphertextAndBurnedReservation(t *testing.T) {
	for _, providerName := range []string{"ga4", "woocommerce"} {
		t.Run(providerName, func(t *testing.T) {
			f, id := selectedCatalogFixture(t, providerName)
			ctx := correlation.New(f.base.ctx)
			checkpoint, err := f.vault.Inspect(ctx, f.actor, clientAID, id)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint, err = f.vault.Replace(ctx, f.actor, clientAID, id, checkpoint, []byte("synthetic-selected-credential"))
			if err != nil {
				t.Fatal(err)
			}
			// Fail only the storage audit: its separately committed reservation
			// remains burned while the ciphertext/connection transaction rolls back.
			if _, err := f.admin.Exec(ctx, `CREATE FUNCTION app.selected_fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.resource_kind='integration_credential' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER selected_fixture_audit_failure BEFORE INSERT ON app.audit_events FOR EACH ROW EXECUTE FUNCTION app.selected_fixture_audit_failure()`); err != nil {
				t.Fatal(err)
			}
			if result, err := f.vault.Replace(ctx, f.actor, clientAID, id, checkpoint, []byte("synthetic-uncommitted-credential")); err != vault.ErrUnavailable || result != (vault.Checkpoint{}) {
				t.Fatal("selected failed storage audit returned success")
			}
			if actual, err := f.vault.Inspect(ctx, f.actor, clientAID, id); err != nil || actual != checkpoint {
				t.Fatal("selected failed storage audit changed checkpoint")
			}
			assertSelectedCiphertext(t, f, id, providerName, f.ring)
			if count, events := f.accounting(t); count != 2 || events != 2 {
				t.Fatal("selected failed storage audit refunded reservation")
			}
			if credentials, connections := f.mutationEvents(t); credentials != 1 || connections != 1 {
				t.Fatal("selected failed storage audit committed partial history")
			}
		})
	}
}

func TestSelectedProviderPendingAndOrphanedHistoryRefuseDowngrade(t *testing.T) {
	for _, providerName := range []string{"ga4", "woocommerce"} {
		t.Run(providerName, func(t *testing.T) {
			f, _ := selectedCatalogFixture(t, providerName)
			before := recoveryFingerprints(t, f.base.ctx, f.admin)
			if _, err := provider(t, f.base).DownTo(f.base.ctx, 21); err == nil || !reflect.DeepEqual(before, recoveryFingerprints(t, f.base.ctx, f.admin)) {
				t.Fatal("pending selected history downgraded")
			}
		})
	}
	t.Run("unresolved_audit", func(t *testing.T) {
		f := newVaultFixture(t)
		// Synthetic orphaned owner-imported audit exercises conservative refusal;
		// it carries no provider identity that could justify a legacy downgrade.
		if _, err := f.admin.Exec(f.base.ctx, `INSERT INTO app.audit_events(actor_kind,actor_user_id,event_name,resource_kind,resource_id,client_id,request_id,before_state,after_state,metadata) VALUES('user',$1,'integration_connection.updated','integration_connection',$2,$3,$4,'{"exists":true,"revision":1}','{"exists":true,"revision":2}','{"source":"cli"}')`, f.actor, connectionID(999), clientAID, correlation.ID(correlation.New(f.base.ctx))); err != nil {
			t.Fatal("synthetic orphan history seed failed")
		}
		before := recoveryFingerprints(t, f.base.ctx, f.admin)
		if _, err := provider(t, f.base).DownTo(f.base.ctx, 21); err == nil || !reflect.DeepEqual(before, recoveryFingerprints(t, f.base.ctx, f.admin)) {
			t.Fatal("unresolved audit history downgraded")
		}
	})
}
