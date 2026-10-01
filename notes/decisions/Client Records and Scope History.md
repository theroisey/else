---
type: decision
status: owner-merged
created: 2026-10-01
tags:
  - clients
  - authorization
  - database
  - audit
---

# Client Records and Scope History

Issue #13 follows owner-merged administration PR #47 at `cf26da0`; both permanent development branches were synchronized. Main [run 36923454442](https://github.com/theroisey/else/actions/runs/36923454442) passed all five gates and tested-image publication. No deployment was performed. The pre-implementation policy is [issue comment 5940200227](https://github.com/theroisey/else/issues/13#issuecomment-5940200227).

Backend PR #48 is owner-merged at `4efc7e8`. Main [run 36927463099](https://github.com/theroisey/else/actions/runs/36927463099) passed all five gates and tested-image publication. Both development branches were synchronized before frontend #14 began. [[Client Interface and Workspace]] consumes this contract.

ClientsCreate is global; view/update/archive are exact-client capabilities. Existing role assignment/delegation remains the sole access mechanism. Creating a record does not grant its creator access. Missing and unauthorized detail/write IDs share 404. Collection queries filter authorization before limit/cursor and expose no hidden totals. UUID ascending/descending keysets keep cursors independent of mutable names; literal name/tag/status filters are bounded. UI is a separate #14 slice.

Archived profiles/contacts/tags and assignment history remain readable under existing view grants. Revisions protect full profile replacement and archive. No edits, restore, physical deletion or new scoped grants on archived records. Assignment creation and archival serialize under the existing authorization advisory lock; the VOLATILE trigger reads fresh committed state after waiting. Revoke remains permitted under normal delegation, including for archived/legacy scopes.

Opaque pre-client grant IDs cannot be converted into invented customer profiles. Migration 000006 registers only existing scope IDs and applies a foreign key from user_roles to that registry. Real clients reference the registry; new scoped assignments require a real active record. Old orphan grants remain history without a readable profile. Client creation accepts no ID and cannot adopt existing legacy grants. A future real-data import must review historical scope assignments before an owner migration inserts a profile at a legacy ID.

Contacts/tags are normalized bounded children, replaced with the profile under one revision/audit transaction. Runtime gets EXECUTE only, with unchecked document/trigger helpers private. Audit snapshots contain existence/revision, including retained existence after archive; no contact/profile/tag values. Empty/scope-only migration rollback preserves prior grants; populated rollback is refused. Reapply runtime grants after an up/down/up cycle.

Existing auth/admin tests now seed actual synthetic clients only where scoped grants are needed. The frontend change is a three-line browser-fixture schema compatibility adaptation; product UI remains untouched. Rollback tests explicitly step past the new empty client migration before asserting older migration refusal, preserving their original intent. The existing four browser flows remain required alongside new client integration/race tests.

- [Client contract and rollout](../../docs/clients.md)
- [[Authorization and Client Scope]]
- [[User and Role Administration]]
- [[Audit Infrastructure]]
