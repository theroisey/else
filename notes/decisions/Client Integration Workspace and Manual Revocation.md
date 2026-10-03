---
type: decision
status: implemented-pending-owner-review
created: 2026-10-03
tags:
  - integrations
  - frontend
  - authorization
---

# Client Integration Workspace and Manual Revocation

Issue #80 supplies the frontend consumer of owner-merged metadata #72 and local fence #78. PR #79 merged at debac21bd2aa665a380be071cd85fca6819a7c6c; final-head CI 37114191531 and merge-head CI 37116529670 passed all five verification gates. Both permanent development branches synchronized before this frontend work. Parent #24 stays open.

List/detail require independent clients.view and integrations.view; manage never substitutes for view. Active-client status is freshly read before exposing local disable. Archived and view-only history stays readable. Stored connected/disconnected states are labeled recorded facts, never current external health. No provider connect/credential/sync producer or production seed is introduced.

The local-disable confirmation explicitly warns that remote revocation is unavailable. Result parsing requires revocation_failed plus manual_action_required=true, and the persistent warning asks for manual removal in Meta's account settings. No success tone or statement claims actual revocation. Current local-disabled and terminal connections offer no repeat action; API no-op remains a freshly authorized backend capability.

Revisions remain int64 decimal strings throughout. The consumer rejects any expansion beyond the seven public metadata fields, cross-client/route identity, invalid microsecond UTC timestamps, unordered/repeated pages and mismatched canonical client-bound cursor boundaries. Public cursors confer no authorization.

Unknown POST outcomes never resubmit automatically. Reload must successfully read both connection and client before clearing the mutation lock; a renewed confirmation uses current revision. Real-browser verification lets the actual API commit before dropping its response, checks the single audit/fence, then recovers by GET to attention state. Shared actor/grant cache partitioning plus keyed inner pages discard old dialogs and late route results.

The domain remains frontend-owned with existing shared transport, components and operation helper. Only frontend/e2e/integration-fixtures.sql introduces conspicuously synthetic metadata on disposable test databases, when the integration browser test starts. This keeps existing pagination and role flows independent of the new fixture. Required verification and responsive screenshots accompany the PR. Future provider policies, startup/restore gates, retirement and synchronization remain separate slices, with no agent merge/deployment.

- [[Local Integration Disconnect Fence]]
- [[Integration Connection Metadata and Read Boundaries]]
- [[Integration View Permission Compatibility]]
