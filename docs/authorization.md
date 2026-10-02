# Permission-based authorization

Related Issue: [#9](https://github.com/theroisey/else/issues/9).

## Authorization contract

The backend authorizes permission identifiers, never role names. Roles are database-managed collections of permissions. Every check starts denied and becomes allowed only when an active user has an effective assignment for the exact known permission and required scope. Missing or unknown permissions, malformed identity/client IDs, absent client context, disabled users and lookup failures do not authorize a request.

Permission definitions are either `global` or `client` scoped. A global permission requires a global role assignment. A client permission is effective when the user has either a global assignment containing it, which covers every client, or a client assignment containing it whose `client_id` exactly matches the requested client. Client assignments never grant global permissions from a mixed role. Knowing a client or record UUID establishes no access.

The initial catalog covers the already-roadmapped administration, client, billing, pricing, task, analytics, integration and release capabilities. `Initial Administrator`, `Finance` and `Viewer` are seeded role definitions. They provide defaults and verification fixtures, but application code contains no role-name decisions. Later domain migrations may add reviewed permission definitions; they must not reinterpret existing identifiers.

## Assignments and delegation

Role assignments retain their global/client scope and are revoked with a timestamp rather than deleted. The runtime role cannot read or write authorization tables directly. Narrow security-definer functions use a fixed `pg_catalog` search path and perform checks and writes under a transaction advisory lock.

An actor assigning or revoking a role must hold global `roles.manage` and every permission that the assignment makes effective. Granting a global role therefore requires global control of all of its applicable permissions; granting a client role requires control of its applicable client permissions for that exact client. A delegated role manager cannot grant permissions they do not control. Invalid, duplicate and unauthorized assignments return the same denial decision to the application.

Assignment creation/revocation and `role_assignment.created`/`role_assignment.archived` audit events share one database transaction. Audit failure rolls the assignment mutation back. Bootstrap creates the first user, assigns the ordinary Initial Administrator role and appends both audit events atomically. Migration `000004_create_authorization.sql` also converts an existing Issue #8 bootstrap marker into the same audited assignment. The marker remains identity initialization history and is never an authorization bypass.

Issue #13 adds [real clients and the scope registry](clients.md). Existing opaque scope history is preserved without fabricated profiles; new scoped assignments require an actual active client. Real client lookups still require the exact permission and ID. Archived clients retain read/history access while domain edits and new assignments are refused.

Issue #15 adds client-scoped `tasks.create`, `tasks.update`, `tasks.delete`. The task API treats existing `tasks.manage` as the aggregate for those three writes, without granting view or reinterpreting unrelated catalog checks/delegation. Initial Administrator receives explicit seed links; custom roles do not expand. New/changed assignees require active exact-client `tasks.view`. See [the task contract](tasks.md) for history and picker boundaries. Current identity/catalog contain 22 known keys.

## Current identity representation

Successful login and `GET /api/v1/auth/session` include flattened effective grants under `data.user.permissions`. Global assignments are represented with `scope: "global"`; client assignments use `scope: "client"` plus `client_id`:

```json
{
  "data": {
    "user": {
      "id": "user-uuid",
      "email": "person@example.com",
      "display_name": "Person",
      "permissions": [
        {"permission": "roles.manage", "scope": "global"},
        {"permission": "clients.view", "scope": "client", "client_id": "client-uuid"}
      ]
    },
    "session": {"expires_at": "2026-10-01T23:00:00Z"}
  }
}
```

The representation is an interface/navigation hint, not a substitute for a backend permission check at every protected boundary. Permission changes take effect on the next identity read; disabled users lose both session access and authorization immediately.

## Database lifecycle and verification

Migration `000004_create_authorization.sql` adds protected permission, role, role-permission and assignment relations, indexes, the initial catalog and narrow evaluation/mutation functions. Runtime receives EXECUTE only on those functions. It has no table SELECT/INSERT/UPDATE/DELETE/TRUNCATE grants. Down is reversible while no assignment history exists; after any assignment, it refuses rollback rather than destroy security history.

Integration coverage exercises the Initial Administrator/Finance/Viewer matrix, global and exact-client scope, Viewer mutation denial, Finance role-administration denial, unknown permissions, disabled users, delegated escalation attempts, audited assignment/revocation, audit-failure rollback, bootstrap conversion, runtime table denial and migration rollback behavior. The Compose permission probe covers the same storage boundary.

Issue #10 delivers [user/role administration](administration.md), including final-administrator storage guards. Issues #13/#14 deliver client API/UI, and #15 adds the [task API](tasks.md); task UI and remaining business modules are later slices.
