---
type: decision
status: implemented-pending-owner-review
created: 2026-10-03
tags:
  - integrations
  - authorization
  - database
---

# Integration Connection Metadata and Read Boundaries

Issue #72 is the next backend slice of parent #24 after owner-merged encryption #68 / PR #69 and frontend compatibility #70 / PR #71. PR #71 merged at `c812882798be05eab62cd9f787e2e67585ae437b`; both branches synchronized and main run 37105863163 passed before this slice. Authorization, ownership, rollback and retention policy was recorded in #72 before code.

Meta Ads is the planned first provider, recorded in [#25](https://github.com/theroisey/else/issues/25#issuecomment-5966713552) following the prior optional choice's default. This selects metadata shape only. Concrete API version/endpoints, minimum scopes, account verification, OAuth/reporting/revocation fixtures must precede provider traffic or credentials.

Migration 15 introduces integrations.view with an explicit Initial Administrator seed only. Both real-client grants, clients.view and integrations.view, are mandatory. No implication from manage/analytics; no automatic custom/Finance/Viewer grant. Readers acquire shared lifecycle lock 871092650209 before fresh authorization; queued revocation/disablement must return no metadata. Runtime receives only two guarded EXECUTE grants; PUBLIC and direct table/helper access stay denied.

One connection permanently belongs to one client/provider/ad account. Numeric account IDs and generation stay private; uniqueness prevents moving the same account across clients. The API exposes seven fields, exact revision strings and UTC timestamps, using bounded client-bound UUID keyset cursors. State reflects stored facts, not a health probe or timestamp inference. Empty and archived-client history are honest; no connection is seeded. Reads produce no audit write. Disconnected metadata remains retained; no deletion endpoint exists. Down refuses any connection or custom/revoked integration-view permission history.

No credential persistence, startup keys, connection lifecycle writer, provider request, metrics or sync is implemented. Future writers require manage, immutable ownership, revision/generation fences and typed transactional audits. Parent #24 remains incomplete. Full backend/real PostgreSQL and final-head five-job CI are required before owner review; no agent merge/deployment is authorized.

- [[Integration View Permission Compatibility]]
- [[Integration Credential Encryption and Rotation]]
- [[Authorization and Client Scope]]
