---
type: decision
status: backend-review
created: 2026-10-02
tags:
  - activity
  - audit
  - authorization
  - database
---

# Client Activity Projection and Read Boundaries

Issue #22 follows owner-merged reminder interface #55 at `0194e8c`. Both permanent development branches were synchronized; main run 37001360296 passed all five gates and tested-image publication. [Contract comment 5951504480](https://github.com/theroisey/else/issues/22#issuecomment-5951504480) records this backend slice before implementation. Owner review/merge precedes the separate activity timeline.

## Source and visibility

Read the append-only audit source directly with a guarded, column-selective SECURITY DEFINER function. This reuses confirmed transactional business events and the existing client/time index without a copied projection/backfill/worker. It reads no uncommitted events, and audit failures roll business changes back before activity can observe them. Reads do not append events or alter history.

Require activity.view plus clients.view, then independently gate task, planning/milestone and reminder events by their current domain view. The new capability is client scoped, expands only Initial Administrator's explicit seed, and grants no raw audit access. Authorship and ownership confer nothing. A profile-only client viewer cannot enumerate operational record IDs through the feed.

Return event/client/resource IDs, UTC event time, reviewed event type/resource kind and static human-readable summary only. Exclude snapshots, actor details, profiles, free-form text, schedule/owner/link metadata, sources and audit correlation IDs. Keep earlier completion visible after reopening, archived resources visible with current grants, and plan terminal updates labeled as the actual recorded update. No event is inferred from present resource state.

## Ordering and compatibility

Newest-first (occurred_at,id) keysets preserve equal-time events and stored microseconds. The bounded versioned base64url cursor carries the client and ordering boundary without an event lookup. Treat it as untrusted input, not a signed capability. This avoids an inaccessible-event existence oracle and keeps a cursor usable when its original row's domain is revoked. Every request rechecks permissions under its statement snapshot; refresh for newer commits, and document late commits with older timestamps rather than promising a cross-request snapshot.

Migration 10 adds the reader and one permission (30 total), with no history table. Unused down/up preserves populated business/audit data; rollback refuses custom/revoked activity grant history. Recreation requires reviewed runtime EXECUTE grants. Earlier-domain migration tests must target known versions, not assume a fixed count of later migrations. Runtime EXECUTE failures remain safe 500 diagnostics; explicit missing/denied client reads use a separate SQL condition mapped to uniform 404.

The frontend recognizes only the new known permission key in this backend slice. Its product timeline comes after owner review. Verification covers all 18 persisted lifecycle labels, scope/redaction, equal-time pagination, revocation/disablement, transaction visibility/rollback, runtime/PUBLIC denial, definer settings, populated migration preservation/refusal and all eight existing browser regressions.

## Related

- [Activity contract](../../docs/activity.md)
- [[Audit Infrastructure]]
- [[Authorization and Client Scope]]
- [[Reminder Interface and Explicit Occurrences]]
- [[CI and Publication]]
