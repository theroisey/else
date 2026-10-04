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

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
	"github.com/theroisey/else/backend/internal/integrations/inventory"
	"github.com/theroisey/else/backend/internal/integrations/rotationcommand"
)

const inventoryFunction = `app.integration_key_inventory(uuid,text[],bytea[],text,boolean)`

func inventoryService(t *testing.T, f *rotationFixture, ring *credentials.Keyring) *inventory.Service {
	t.Helper()
	if _, e := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION `+inventoryFunction+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	s, e := inventory.NewService(f.runtime, ring)
	if e != nil {
		t.Fatal(e)
	}
	return s
}

func assertInventory(t *testing.T, s *inventory.Service, ctx context.Context, actor string, stored, eligible int64) {
	t.Helper()
	counts, e := s.Observe(correlation.New(ctx), actor, false)
	if e != nil || len(counts) != 2 || counts[0] != (inventory.Count{Position: 1, Active: true, StoredRows: "0", EligibleRows: "0", ExcludedRows: "0"}) || counts[1] != (inventory.Count{Position: 2, StoredRows: fmt.Sprint(stored), EligibleRows: fmt.Sprint(eligible), ExcludedRows: fmt.Sprint(stored - eligible)}) {
		t.Fatal("live inventory counts/source positions incorrect", e)
	}
}

func TestIntegrationInventoryCountsAllClientsAndExcludedRetainedRowsWithoutWrites(t *testing.T) {
	f := newRotationFixture(t, 5)
	s := inventoryService(t, f, f.ring)
	for n, state := range map[int]string{2: "revocation_failed", 3: "disconnected"} {
		if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET state=$2 WHERE id=$1::uuid`, connectionID(n), state); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET generation=generation+1 WHERE id=$1::uuid`, connectionID(4)); e != nil {
		t.Fatal(e)
	}
	f.seed(t, clientBID, 6, 1)
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.integration_connections SET revision=1 WHERE id=$1::uuid`, connectionID(6)); e != nil {
		t.Fatal(e)
	}
	c, e := f.vault.Inspect(correlation.New(f.base.ctx), f.actor, clientBID, connectionID(6))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.vault.Replace(correlation.New(f.base.ctx), f.actor, clientBID, connectionID(6), c, []byte("synthetic-batch-token")); e != nil {
		t.Fatal(e)
	}
	if _, e = f.admin.Exec(f.base.ctx, `UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, clientBID); e != nil {
		t.Fatal(e)
	}
	before, events := f.accounting(t)
	a, b := f.mutationEvents(t)
	assertInventory(t, s, f.base.ctx, f.actor, 6, 2)
	assertInventory(t, s, f.base.ctx, f.actor, 6, 2)
	if n, ev := f.accounting(t); n != before || ev != events {
		t.Fatal("read-only inventory reserved/encrypted")
	}
	if c, d := f.mutationEvents(t); c != a || d != b {
		t.Fatal("read-only inventory mutated/audited")
	}
	if r, e := f.rotation.Run(correlation.New(f.base.ctx), f.actor, clientAID, "", 1); e != nil || r.Rewrapped != 1 {
		t.Fatal("rotation fixture failed", e)
	}
	counts, e := s.Observe(correlation.New(f.base.ctx), f.actor, false)
	if e != nil || counts[0].StoredRows != "1" || counts[0].EligibleRows != "0" || counts[0].ExcludedRows != "1" || counts[1].StoredRows != "5" || counts[1].EligibleRows != "1" || counts[1].ExcludedRows != "4" {
		t.Fatal("active/excluded observation failed", e)
	}
	data, e := json.Marshal(counts)
	if e != nil || bytes.Contains(data, []byte("synthetic")) || bytes.Contains(data, []byte("fingerprint")) || bytes.Contains(data, []byte("key_label")) {
		t.Fatal("inventory exposed private identity")
	}
}

func inventoryActor(t *testing.T, f *rotationFixture, n int, perms []authorization.Permission, scope authorization.Scope) (string, string) {
	t.Helper()
	ctx := correlation.New(f.base.ctx)
	u := f.user(t, fmt.Sprintf("inventory-%d@example.com", n))
	r, e := f.accounts.CreateRole(ctx, f.actor, fmt.Sprintf("Synthetic inventory %d", n), perms)
	if e != nil {
		t.Fatal(e)
	}
	client := ""
	if scope == authorization.Client {
		client = clientAID
	}
	a, e := f.authorizer.AssignRole(ctx, f.actor, u.ID, r.ID, scope, client)
	if e != nil {
		t.Fatal(e)
	}
	return u.ID, a
}

func TestIntegrationInventoryRequiresBothGlobalGrantsEvenWhenEmpty(t *testing.T) {
	f := newRotationFixture(t, 0)
	s := inventoryService(t, f, f.ring)
	for i, perms := range [][]authorization.Permission{{authorization.ClientsView}, {authorization.IntegrationsManage}, {authorization.ClientsView, authorization.IntegrationsManage}} {
		user, _ := inventoryActor(t, f, i, perms, authorization.Client)
		if rows, e := s.Observe(correlation.New(f.base.ctx), user, false); e != inventory.ErrMissing || rows != nil {
			t.Fatal("client-only global inventory allowed", e)
		}
	}
	for i, perms := range [][]authorization.Permission{{authorization.ClientsView}, {authorization.IntegrationsManage}, {authorization.ClientsView, authorization.IntegrationsManage}} {
		ctx := correlation.New(f.base.ctx)
		user, assignment := inventoryActor(t, f, i+10, perms, authorization.Global)
		rows, e := s.Observe(correlation.New(f.base.ctx), user, false)
		if len(perms) != 2 {
			if e != inventory.ErrMissing || rows != nil {
				t.Fatal("partial global grants allowed", e)
			}
		} else {
			if e != nil || len(rows) != 2 || rows[0].StoredRows != "0" || rows[1].StoredRows != "0" {
				t.Fatal("full global empty inventory refused", e)
			}
			if e = f.authorizer.RevokeRole(ctx, f.actor, assignment); e != nil {
				t.Fatal(e)
			}
			if rows, e = s.Observe(correlation.New(f.base.ctx), user, false); e != inventory.ErrMissing || rows != nil {
				t.Fatal("revoked global grant observed inventory", e)
			}
		}
	}
	user, _ := inventoryActor(t, f, 20, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage}, authorization.Global)
	if _, e := f.admin.Exec(f.base.ctx, `UPDATE app.users SET status='disabled' WHERE id=$1::uuid`, user); e != nil {
		t.Fatal(e)
	}
	if rows, e := s.Observe(correlation.New(f.base.ctx), user, false); e != inventory.ErrMissing || rows != nil {
		t.Fatal("disabled global actor observed inventory", e)
	}
}

func TestIntegrationInventoryIdentityRestoreExhaustionAndBoundedSlots(t *testing.T) {
	f := newRotationFixture(t, 1)
	s := inventoryService(t, f, f.ring)
	if rows, e := s.Observe(correlation.New(f.base.ctx), f.actor, true); e != nil || len(rows) != 2 {
		t.Fatal("fresh declared-restore inventory failed", e)
	}
	for _, ring := range []*credentials.Keyring{syntheticRing(t, "synthetic-fresh", 0x73), syntheticRing(t, "synthetic-alias", 0x6b), retainedRing(t, "synthetic-fresh", 0x61)} {
		service := inventoryService(t, f, ring)
		if rows, e := service.Observe(correlation.New(f.base.ctx), f.actor, false); e != inventory.ErrUnavailable || rows != nil {
			t.Fatal("missing/aliased retained identity observed", e)
		}
	}
	f.seedCount(t, f.ring, 1<<24)
	before, events := f.accounting(t)
	assertInventory(t, s, f.base.ctx, f.actor, 1, 1)
	if rows, e := s.Observe(correlation.New(f.base.ctx), f.actor, true); e != inventory.ErrUnavailable || rows != nil {
		t.Fatal("declared restore reused registered active identity", e)
	}
	if r, e := f.rotation.Run(correlation.New(f.base.ctx), f.actor, clientAID, "", 1); e == nil || r.Rewrapped != 0 {
		t.Fatal("inventory loosened exhausted write preflight")
	}
	if n, ev := f.accounting(t); n != before || ev != events {
		t.Fatal("observation changed exhausted accounting")
	}
	keys := map[string][]byte{"synthetic-primary": bytes.Repeat([]byte{0x6b}, 32)}
	for n := 1; n <= 7; n++ {
		keys[fmt.Sprintf("new-%d", n)] = bytes.Repeat([]byte{byte(n)}, 32)
	}
	ring, e := credentials.New("new-1", keys)
	if e != nil {
		t.Fatal("synthetic eight-key source")
	}
	service := inventoryService(t, f, ring)
	rows, e := service.Observe(correlation.New(f.base.ctx), f.actor, false)
	if e != nil || len(rows) != 8 || rows[0].Position != 1 || !rows[0].Active || rows[7].Position != 8 || rows[7].StoredRows != "1" {
		t.Fatal("bounded source positions failed", e)
	}
}

func TestIntegrationInventoryPrivateSQLAndPopulatedRollback(t *testing.T) {
	f := newRotationFixture(t, 1)
	s := inventoryService(t, f, f.ring)
	var secure, public bool
	if e := f.admin.QueryRow(f.base.ctx, `SELECT prosecdef AND provolatile='v' AND lower(array_to_string(proconfig,',')) LIKE '%search_path=pg_catalog%' AND lower(array_to_string(proconfig,',')) LIKE '%timezone=utc%',EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') FROM pg_proc WHERE oid=$1::regprocedure`, inventoryFunction).Scan(&secure, &public); e != nil || !secure || public {
		t.Fatal("unsafe inventory definer")
	}
	labels, digests, _ := f.ring.KeyIdentities()
	for _, tc := range []struct {
		labels   any
		digests  any
		active   any
		restored any
	}{
		{nil, digests, "synthetic-fresh", false}, {[]string{}, [][]byte{}, "synthetic-fresh", false},
		{labels, digests[:1], "synthetic-fresh", false}, {[]string{labels[0], labels[0]}, digests, "synthetic-fresh", false},
		{labels, [][]byte{digests[0], digests[0]}, "synthetic-fresh", false}, {labels, digests, "missing-active", false},
		{labels, digests, "synthetic-fresh", nil}, {[]string{"UPPER", labels[1]}, digests, "UPPER", false},
		{labels, [][]byte{bytes.Repeat([]byte{0}, 32), digests[1]}, "synthetic-fresh", false},
	} {
		if _, e := f.runtime.Exec(f.base.ctx, `SELECT * FROM app.integration_key_inventory($1::uuid,$2::text[],$3::bytea[],$4::text,$5::boolean)`, f.actor, tc.labels, tc.digests, tc.active, tc.restored); e == nil {
			t.Fatal("malformed inventory arrays accepted")
		}
	}
	if _, e := f.runtime.Exec(f.base.ctx, `SELECT * FROM app.integration_key_inventory($1::uuid,'[0:0]={synthetic-fresh}'::text[],ARRAY[$2::bytea],'synthetic-fresh',false)`, f.actor, digests[0]); e == nil {
		t.Fatal("non-one-based source accepted")
	}
	for _, table := range []string{"app.integration_credentials", "app.integration_encryption_keys"} {
		if _, e := f.runtime.Exec(f.base.ctx, `SELECT * FROM `+table); e == nil {
			t.Fatal("private table exposed")
		}
	}
	p := provider(t, f.base)
	// Target the inventory predecessor explicitly; later catalog migrations
	// preserve this entrypoint instead of removing it.
	if _, e := p.DownTo(f.base.ctx, 20); e != nil {
		t.Fatal(e)
	}
	f.assertRow(t, 1, false, 2, 1, 2)
	if n, ev := f.accounting(t); n != 1 || ev != 1 {
		t.Fatal("inventory down destroyed history")
	}
	if rows, e := s.Observe(correlation.New(f.base.ctx), f.actor, false); e != inventory.ErrUnavailable || rows != nil {
		t.Fatal("removed inventory entrypoint callable")
	}
	if ids, e := rotationIDs(correlation.New(f.base.ctx), f.runtime, f.actor, clientAID, f.ring, nil, 1); e != nil || len(ids) != 1 {
		t.Fatal("inventory down changed predecessor entrypoint", e)
	}
	if _, e := p.Up(f.base.ctx); e != nil {
		t.Fatal(e)
	}
	if rows, e := s.Observe(correlation.New(f.base.ctx), f.actor, false); e != inventory.ErrUnavailable || rows != nil {
		t.Fatal("inventory up retained old EXECUTE")
	}
	s = inventoryService(t, f, f.ring)
	assertInventory(t, s, f.base.ctx, f.actor, 1, 1)
}

func TestIntegrationInventoryQueuedRevocationAndCancellation(t *testing.T) {
	f := newRotationFixture(t, 1)
	s := inventoryService(t, f, f.ring)
	actor, assignment := inventoryActor(t, f, 30, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage}, authorization.Global)
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
	go func() { _, e := s.Observe(ctx, actor, false); answers <- e }()
	waitBudgetLock(t, ctx, f.adminPool)
	if _, e = tx.Exec(ctx, `UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, assignment); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = <-answers; e != inventory.ErrMissing {
		t.Fatal("queued inventory used stale grants", e)
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
	if rows, e := s.Observe(short, f.actor, false); e != inventory.ErrUnavailable || rows != nil {
		t.Fatal("canceled inventory returned partial counts")
	}
	done()
	if e = block.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	assertInventory(t, s, ctx, f.actor, 1, 1)
}

func TestIntegrationInventoryCommandObservationOutputLossAndDeniedActor(t *testing.T) {
	f := newRotationCommandFixture(t, 2)
	_ = inventoryService(t, f.rotationFixture, f.ring)
	lookup := func(k string) (string, bool) { v, ok := f.environment[k]; return v, ok }
	args := []string{"--inventory", "--actor", f.actor}
	var out, diagnostic bytes.Buffer
	var before, after int
	if e := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.audit_events`).Scan(&before); e != nil {
		t.Fatal(e)
	}
	if rotationcommand.Run(f.base.ctx, args, lookup, &out, &diagnostic) != 0 || diagnostic.Len() != 0 {
		t.Fatal("inventory command failed")
	}
	var report struct {
		Status      string            `json:"status"`
		Actor       string            `json:"actor_id"`
		Correlation string            `json:"correlation_id"`
		Keys        []inventory.Count `json:"keys"`
	}
	if out.Len() > 4096 || json.Unmarshal(out.Bytes(), &report) != nil || report.Status != "inventory_observed" || report.Actor != f.actor || report.Correlation == "" || len(report.Keys) != 2 || report.Keys[1].StoredRows != "2" || report.Keys[1].EligibleRows != "2" {
		t.Fatal("command observation malformed")
	}
	for _, private := range []string{f.environment["DATABASE_URL"], f.environment["INTEGRATION_KEYRING_FILE"], "synthetic-primary", "synthetic-fresh", "synthetic-batch-token", clientAID, connectionID(1)} {
		if strings.Contains(out.String(), private) {
			t.Fatal("command exposed private inventory context")
		}
	}
	out.Reset()
	diagnostic.Reset()
	if rotationcommand.Run(f.base.ctx, args, lookup, lostCommandOutput{}, &diagnostic) != 1 || !strings.Contains(diagnostic.String(), "integration_rotation_output_failed") {
		t.Fatal("inventory output loss reported success")
	}
	if n, ev := f.accounting(t); n != 2 || ev != 2 {
		t.Fatal("inventory command mutated accounting")
	}
	if e := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.audit_events`).Scan(&after); e != nil || after != before {
		t.Fatal("read-only command wrote audits")
	}
	actor, _ := inventoryActor(t, f.rotationFixture, 40, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage}, authorization.Client)
	out.Reset()
	diagnostic.Reset()
	if rotationcommand.Run(f.base.ctx, []string{"--inventory", "--actor", actor}, lookup, &out, &diagnostic) != 1 || out.Len() != 0 || !strings.Contains(diagnostic.String(), "integration_inventory_missing") {
		t.Fatal("client-scoped command exposed inventory")
	}
	f.assertRow(t, 1, false, 2, 1, 2)
	f.assertRow(t, 2, false, 2, 1, 2)
}
