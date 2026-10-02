//go:build integration

package integration

import (
	"testing"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
)

func TestActivityMigrationPreservesPopulatedBusinessAndAuditHistory(t *testing.T) {
	f := newActivityFixture(t)
	f.seedBusiness(t)
	var before string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT md5(string_agg(row_to_json(e)::text,'' ORDER BY id)) FROM app.audit_events e`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	p := provider(t, f.base)
	for _, direction := range []string{"down", "up"} {
		var err error
		if direction == "down" {
			_, err = p.DownTo(f.base.ctx, 9)
		} else {
			_, err = p.Up(f.base.ctx)
		}
		if err != nil {
			t.Fatal("unused activity migration failed", err)
		}
		var after string
		var keys int
		var readable bool
		if err := f.admin.QueryRow(f.base.ctx, `SELECT (SELECT md5(string_agg(row_to_json(e)::text,'' ORDER BY id)) FROM app.audit_events e),(SELECT count(*) FROM app.permissions),to_regprocedure('app.activity_list(uuid,uuid,timestamptz,uuid,integer)') IS NOT NULL`).Scan(&after, &keys, &readable); err != nil || after != before || readable != (direction == "up") {
			t.Fatal("activity migration changed immutable history", err)
		}
		expected := 29
		if direction == "up" {
			expected = 30
		}
		if keys != expected {
			t.Fatal("unexpected permission catalog", keys)
		}
		var records int
		if err := f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.tasks)+(SELECT count(*) FROM app.plans)+(SELECT count(*) FROM app.milestones)+(SELECT count(*) FROM app.reminders)`).Scan(&records); err != nil || records != 4 {
			t.Fatal("migration changed business records", err)
		}
	}
	// Recreation deliberately requires reviewed runtime EXECUTE reapplication.
	if _, err := f.runtime.Exec(f.base.ctx, `SELECT * FROM app.activity_list($1::uuid,$2::uuid,NULL,NULL,25)`, f.actor, clientAID); err == nil {
		t.Fatal("recreated function inherited runtime privilege")
	}
	if _, err := f.admin.Exec(f.base.ctx, `GRANT EXECUTE ON FUNCTION app.activity_list(uuid,uuid,timestamptz,uuid,integer) TO `+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, f.actor, clientAID, "", 25).Data) != 5 {
		t.Fatal("upgrade did not project old events")
	}
	var seeds int
	var scope string
	if err := f.admin.QueryRow(f.base.ctx, `SELECT (SELECT count(*) FROM app.role_permissions WHERE permission_key='activity.view' AND role_id=$1::uuid AND seeded AND revoked_at IS NULL),(SELECT scope_kind FROM app.permissions WHERE permission_key='activity.view')`, authorization.InitialAdministratorRoleID).Scan(&seeds, &scope); err != nil || seeds != 1 || scope != "client" {
		t.Fatal("activity permission seeding invalid", err)
	}
	var other int
	if err := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.role_permissions WHERE permission_key='activity.view' AND role_id<>$1::uuid`, authorization.InitialAdministratorRoleID).Scan(&other); err != nil || other != 0 {
		t.Fatal("activity automatically granted to other roles", err)
	}
}
func TestActivityRollbackRefusesCustomOrRevokedGrantHistory(t *testing.T) {
	for _, scenario := range []string{"custom active", "custom revoked", "seed revoked"} {
		t.Run(scenario, func(t *testing.T) {
			f := newActivityFixture(t)
			ctx := correlation.New(f.base.ctx)
			if scenario == "seed revoked" {
				if _, err := f.admin.Exec(ctx, `UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE permission_key='activity.view' AND seeded`); err != nil {
					t.Fatal(err)
				}
			} else {
				role, err := f.accounts.CreateRole(ctx, f.actor, "Activity history", []authorization.Permission{authorization.ActivityView})
				if err != nil {
					t.Fatal(err)
				}
				if scenario == "custom revoked" {
					if _, err := f.accounts.ReplacePermissions(ctx, f.actor, role.ID, 1, []authorization.Permission{authorization.ClientsView}); err != nil {
						t.Fatal(err)
					}
				}
			}
			var before string
			if err := f.admin.QueryRow(ctx, `SELECT md5(string_agg(row_to_json(p)::text,'' ORDER BY id)) FROM app.role_permissions p`).Scan(&before); err != nil {
				t.Fatal(err)
			}
			if _, err := provider(t, f.base).DownTo(ctx, 9); err == nil {
				t.Fatal("rollback erased activity permission history")
			}
			var after string
			var version int
			var reader bool
			if err := f.admin.QueryRow(ctx, `SELECT (SELECT md5(string_agg(row_to_json(p)::text,'' ORDER BY id)) FROM app.role_permissions p),(SELECT max(version_id) FROM public.goose_db_version WHERE is_applied),to_regprocedure('app.activity_list(uuid,uuid,timestamptz,uuid,integer)') IS NOT NULL`).Scan(&after, &version, &reader); err != nil || before != after || version != 10 || !reader {
				t.Fatal("refused rollback was not atomic", err)
			}
		})
	}
}
