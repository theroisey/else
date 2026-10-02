//go:build integration

package integration

import (
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/billing"
	"github.com/theroisey/else/backend/internal/correlation"
	"testing"
)

func TestBillingEmptyDownUpPreservesOldHistoryAndRequiresNewRuntimeGrants(t *testing.T) {
	f := newBillingFixture(t)
	ctx := correlation.New(f.base.ctx)
	p := provider(t, f.base)
	var before string
	if e := f.admin.QueryRow(ctx, `SELECT md5(string_agg(row_to_json(e)::text,'' ORDER BY id)) FROM app.audit_events e`).Scan(&before); e != nil {
		t.Fatal(e)
	}
	for _, direction := range []string{"down", "up"} {
		var e error
		if direction == "down" {
			_, e = p.DownTo(ctx, 11)
		} else {
			_, e = p.Up(ctx)
		}
		if e != nil {
			t.Fatal(e)
		}
		var after string
		var keys int
		if e = f.admin.QueryRow(ctx, `SELECT (SELECT md5(string_agg(row_to_json(e)::text,'' ORDER BY id)) FROM app.audit_events e),(SELECT count(*) FROM app.permissions)`).Scan(&after, &keys); e != nil || before != after || direction == "down" && keys != 30 || direction == "up" && keys != 33 {
			t.Fatal("billing migration changed old history", e, keys)
		}
	}
	if _, e := f.billing.List(ctx, f.actor, clientAID, billing.Filter{Limit: 25, Status: "all"}); e == nil {
		t.Fatal("recreated finance function inherited runtime grant")
	}
	if _, e := f.admin.Exec(ctx, `GRANT EXECUTE ON FUNCTION `+billingFunctions+` TO `+f.runtimeRole); e != nil {
		t.Fatal(e)
	}
	if _, e := f.billing.Create(ctx, f.actor, clientAID, billingProfile()); e != nil {
		t.Fatal("recreated financial audit policy failed", e)
	}
	var seeds int
	if e := f.admin.QueryRow(ctx, `SELECT count(*) FROM app.role_permissions WHERE permission_key IN ('billing.create','billing.update','billing.delete') AND (role_id<>$1::uuid OR NOT seeded)`, authorization.InitialAdministratorRoleID).Scan(&seeds); e != nil || seeds != 0 {
		t.Fatal("finance/custom roles expanded", e)
	}
}

func TestBillingMigrationRefusesCollectionsPaymentsCancellationAndGrantHistory(t *testing.T) {
	for _, scenario := range []string{"unpaid", "paid", "cancelled", "audit-only", "custom revoked permission", "revoked seed"} {
		t.Run(scenario, func(t *testing.T) {
			f := newBillingFixture(t)
			ctx := correlation.New(f.base.ctx)
			switch scenario {
			case "unpaid", "paid", "cancelled":
				m := f.createCollection(t, billingProfile())
				if scenario == "paid" {
					f.payment(t, m, billingPayment(1, "100"))
				}
				if scenario == "cancelled" {
					if _, e := f.billing.Cancel(ctx, f.actor, clientAID, m.ID, m.Revision); e != nil {
						t.Fatal(e)
					}
				}
			case "audit-only":
				if _, e := f.runtime.Exec(ctx, `INSERT INTO app.audit_events `+auditColumns+` VALUES('user',$1::uuid,'billing.created','billing',$2::uuid,$3::uuid,$4,'null','{"exists":true}','{"source":"http"}')`, f.actor, fixtureID, clientAID, correlation.ID(ctx)); e != nil {
					t.Fatal(e)
				}
			case "custom revoked permission":
				role, e := f.accounts.CreateRole(ctx, f.actor, "Synthetic billing grant history", []authorization.Permission{authorization.BillingUpdate})
				if e != nil {
					t.Fatal(e)
				}
				if _, e = f.accounts.ReplacePermissions(ctx, f.actor, role.ID, 1, []authorization.Permission{authorization.BillingView}); e != nil {
					t.Fatal(e)
				}
			case "revoked seed":
				if _, e := f.admin.Exec(ctx, `UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id=$1::uuid AND permission_key='billing.create'`, authorization.InitialAdministratorRoleID); e != nil {
					t.Fatal(e)
				}
			}
			if _, e := provider(t, f.base).DownTo(ctx, 11); e == nil {
				t.Fatal("rollback removed financial or permission history", scenario)
			}
			var present bool
			if e := f.admin.QueryRow(ctx, `SELECT to_regclass('app.collections') IS NOT NULL AND to_regprocedure('app.billing_write(uuid,uuid,uuid,bigint,text,jsonb,uuid)') IS NOT NULL`).Scan(&present); e != nil || !present {
				t.Fatal("failed down left partial schema", e)
			}
		})
	}
}
