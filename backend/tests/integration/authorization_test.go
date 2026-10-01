//go:build integration

package integration

import (
	"errors"
	"testing"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/identity"
)

const (
	financeUserID = "11111111-1111-4111-8111-111111111112"
	viewerUserID  = "11111111-1111-4111-8111-111111111113"
	managerUserID = "11111111-1111-4111-8111-111111111114"
	managerRoleID = "22222222-2222-4222-8222-222222222222"
	clientAID     = "33333333-3333-4333-8333-333333333331"
	clientBID     = "33333333-3333-4333-8333-333333333332"
)

func TestPermissionMatrixScopeAndPrivilegeEscalation(t *testing.T) {
	f := newIdentityFixture(t)
	seedClientScopes(t, f)
	adminID := f.bootstrap(t)
	hash, err := (identity.ArgonPasswords{}).Hash(bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO app.users (id,email,display_name,password_hash) VALUES
		 ('` + financeUserID + `','finance@example.com','Finance User','` + hash + `'),
		 ('` + viewerUserID + `','viewer@example.com','Viewer User','` + hash + `'),
		 ('` + managerUserID + `','manager@example.com','Role Manager','` + hash + `')`,
		`INSERT INTO app.roles (id,role_key,display_name) VALUES ('` + managerRoleID + `','role_manager_fixture','Role Manager Fixture')`,
		`INSERT INTO app.role_permissions (id,role_id,permission_key) VALUES ('22222222-2222-4222-8222-222222222223','` + managerRoleID + `','roles.manage')`,
		`INSERT INTO app.user_roles (id,user_id,role_id,scope_kind) VALUES
		 ('44444444-4444-4444-8444-444444444441','` + financeUserID + `','` + authorization.FinanceRoleID + `','global'),
		 ('44444444-4444-4444-8444-444444444442','` + managerUserID + `','` + managerRoleID + `','global')`,
		`INSERT INTO app.user_roles (id,user_id,role_id,scope_kind,client_id) VALUES
		 ('44444444-4444-4444-8444-444444444443','` + viewerUserID + `','` + authorization.ViewerRoleID + `','client','` + clientAID + `')`,
	} {
		if _, err := f.admin.Exec(f.base.ctx, statement); err != nil {
			t.Fatal(err)
		}
	}

	assertAllowed := func(user string, permission authorization.Permission, client string, want bool) {
		t.Helper()
		got, err := f.authorizer.Allowed(f.base.ctx, user, permission, client)
		if err != nil || got != want {
			t.Fatalf("permission %s for %s at %s: got %t, want %t: %v", permission, user, client, got, want, err)
		}
	}
	assertAllowed(adminID, authorization.RolesManage, "", true)
	assertAllowed(adminID, authorization.ClientsUpdate, clientBID, true)
	assertAllowed(financeUserID, authorization.BillingManage, clientBID, true)
	assertAllowed(financeUserID, authorization.RolesManage, "", false)
	assertAllowed(viewerUserID, authorization.ClientsView, clientAID, true)
	assertAllowed(viewerUserID, authorization.ClientsUpdate, clientAID, false)
	assertAllowed(viewerUserID, authorization.ClientsView, clientBID, false)
	assertAllowed(viewerUserID, authorization.Permission("unknown.permission"), clientAID, false)
	assertAllowed(viewerUserID, authorization.ClientsView, "", false)

	ctx := correlation.New(f.base.ctx)
	if _, err := f.authorizer.AssignRole(ctx, financeUserID, viewerUserID, authorization.ViewerRoleID, authorization.Client, clientBID); !errors.Is(err, authorization.ErrDenied) {
		t.Fatal("Finance role administered assignments")
	}
	if _, err := f.authorizer.AssignRole(ctx, managerUserID, viewerUserID, authorization.FinanceRoleID, authorization.Global, ""); !errors.Is(err, authorization.ErrDenied) {
		t.Fatal("role manager granted permissions it did not control")
	}
	if _, err := f.authorizer.AssignPermission(ctx, managerUserID, managerRoleID, authorization.ClientsUpdate); !errors.Is(err, authorization.ErrDenied) {
		t.Fatal("role manager assigned a permission it did not control")
	}
	permissionAssignmentID, err := f.authorizer.AssignPermission(ctx, adminID, managerRoleID, authorization.ClientsUpdate)
	if err != nil {
		t.Fatal(err)
	}
	assertAllowed(managerUserID, authorization.ClientsUpdate, clientAID, true)
	if err := f.authorizer.RevokePermission(ctx, adminID, permissionAssignmentID); err != nil {
		t.Fatal(err)
	}
	assertAllowed(managerUserID, authorization.ClientsUpdate, clientAID, false)
	var permissionEvents int
	if err := f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid", permissionAssignmentID).Scan(&permissionEvents); err != nil || permissionEvents != 2 {
		t.Fatal("permission assignment lifecycle was not audited")
	}
	assignmentID, err := f.authorizer.AssignRole(ctx, adminID, viewerUserID, authorization.ViewerRoleID, authorization.Client, clientBID)
	if err != nil {
		t.Fatal(err)
	}
	assertAllowed(viewerUserID, authorization.ClientsView, clientBID, true)
	if err := f.authorizer.RevokeRole(ctx, adminID, assignmentID); err != nil {
		t.Fatal(err)
	}
	assertAllowed(viewerUserID, authorization.ClientsView, clientBID, false)
	var auditEvents int
	if err := f.admin.QueryRow(f.base.ctx, "SELECT count(*) FROM app.audit_events WHERE resource_id=$1::uuid", assignmentID).Scan(&auditEvents); err != nil || auditEvents != 2 {
		t.Fatal("role assignment lifecycle was not audited")
	}

	if _, err := f.admin.Exec(f.base.ctx, "UPDATE app.users SET status='disabled' WHERE id=$1::uuid", viewerUserID); err != nil {
		t.Fatal(err)
	}
	assertAllowed(viewerUserID, authorization.ClientsView, clientAID, false)
}

func TestRoleAssignmentAuditFailureRollsBackAndRuntimeCannotBypassPolicy(t *testing.T) {
	f := newIdentityFixture(t)
	seedClientScopes(t, f)
	adminID := f.bootstrap(t)
	hash, err := (identity.ArgonPasswords{}).Hash(bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(f.base.ctx, `INSERT INTO app.users (id,email,display_name,password_hash)
		VALUES ($1::uuid,'target@example.com','Target User',$2)`, viewerUserID, hash); err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(f.base.ctx, `INSERT INTO app.roles (id,role_key,display_name)
		VALUES ($1::uuid,'audit_failure_fixture','Audit Failure Fixture')`, managerRoleID); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{
		"SELECT * FROM app.permissions", "SELECT * FROM app.roles", "SELECT * FROM app.role_permissions", "SELECT * FROM app.user_roles",
		"INSERT INTO app.user_roles (id,user_id,role_id,scope_kind) VALUES ('44444444-4444-4444-8444-444444444449','" + viewerUserID + "','" + authorization.ViewerRoleID + "','global')",
		"UPDATE app.user_roles SET revoked_at=now()", "DELETE FROM app.user_roles", "TRUNCATE app.user_roles",
	} {
		if _, err := f.runtime.Exec(f.base.ctx, sql); err == nil {
			t.Fatalf("runtime bypassed authorization storage with %s", sql)
		}
	}
	if _, err := f.admin.Exec(f.base.ctx, "REVOKE INSERT "+auditColumns+" ON app.audit_events FROM "+f.runtimeRole); err != nil {
		t.Fatal(err)
	}
	if _, err := f.authorizer.AssignRole(correlation.New(f.base.ctx), adminID, viewerUserID, authorization.ViewerRoleID, authorization.Client, clientBID); err == nil {
		t.Fatal("audit failure allowed role assignment")
	}
	if _, err := f.authorizer.AssignPermission(correlation.New(f.base.ctx), adminID, managerRoleID, authorization.ClientsUpdate); err == nil {
		t.Fatal("audit failure allowed permission assignment")
	}
	var assignments int
	if err := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.user_roles
		WHERE user_id=$1::uuid AND role_id=$2::uuid AND client_id=$3::uuid AND revoked_at IS NULL`, viewerUserID, authorization.ViewerRoleID, clientBID).Scan(&assignments); err != nil || assignments != 0 {
		t.Fatal("audit failure left a partial role assignment")
	}
	if err := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.role_permissions
		WHERE role_id=$1::uuid AND permission_key=$2 AND revoked_at IS NULL`, managerRoleID, authorization.ClientsUpdate).Scan(&assignments); err != nil || assignments != 0 {
		t.Fatal("audit failure left a partial permission assignment")
	}
}

func TestAuthorizationMigrationConsumesExistingBootstrapMarker(t *testing.T) {
	f := newFixture(t)
	p := provider(t, f)
	if _, err := p.UpTo(f.ctx, 3); err != nil {
		t.Fatal(err)
	}
	conn := connection(t, f)
	hash, err := (identity.ArgonPasswords{}).Hash(bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(f.ctx, `INSERT INTO app.users (id,email,display_name,password_hash,bootstrap_admin)
		VALUES ($1::uuid,$2,$3,$4,true)`, viewerUserID, bootstrapEmail, bootstrapName, hash); err != nil {
		t.Fatal(err)
	}
	if _, err := p.UpTo(f.ctx, 4); err != nil {
		t.Fatal(err)
	}
	var assignments, events int
	if err := conn.QueryRow(f.ctx, `SELECT
		(SELECT count(*) FROM app.user_roles WHERE user_id=$1::uuid AND role_id=$2::uuid AND scope_kind='global'),
		(SELECT count(*) FROM app.audit_events WHERE resource_kind='role_assignment' AND actor_kind='system')`, viewerUserID, authorization.InitialAdministratorRoleID).Scan(&assignments, &events); err != nil || assignments != 1 || events != 1 {
		t.Fatal("existing bootstrap marker was not consumed into audited RBAC state")
	}
	if _, err := p.Down(f.ctx); err == nil {
		t.Fatal("authorization rollback destroyed assignment history")
	}
}
