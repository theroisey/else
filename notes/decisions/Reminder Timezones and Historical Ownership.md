---
type: decision
status: active
created: 2026-10-02
tags:
  - reminders
  - backend
  - authorization
  - timezones
  - audit
---

# Reminder Timezones and Historical Ownership

Issue #18 follows owner-merged planning interface PR #53 at `60c8c59`. Both permanent development branches were synchronized before implementation; main [run 36982743970](https://github.com/theroisey/else/actions/runs/36982743970) passed all five gates and tested-image publication. The [reminder contract](https://github.com/theroisey/else/issues/18#issuecomment-5948078773) was recorded before source edits, and the [timezone compatibility clarification](https://github.com/theroisey/else/issues/18#issuecomment-5948636628) preceded the storage refinement. The [API guide](../../docs/reminders.md) is the consumer contract. Owner merge of backend PR #54 at `59e0aa2` is complete. Main [run 36994556915](https://github.com/theroisey/else/actions/runs/36994556915) passed all five gates and tested-image publication; both development branches were synchronized. [[Reminder Interface and Explicit Occurrences]] consumes this contract and completes #18 after owner review/merge. Agents do not merge or deploy.

Creation and metadata replacement require original wall clock, named IANA zone and an explicit integer offset, including zero for UTC. UTC is computed and validated in Go and SQL. Both repeated-hour occurrences are available through explicit selection; nonexistent times never normalize silently. Local/UTC year bounds and microseconds are preserved. Go embeds tzdata for minimal images.

Persisted UTC, canonical wall clock, zone and offset record scheduling intent. Storage enforces arithmetic consistency without reinterpreting changing IANA rules. New/full replacement metadata must agree with current rules in both runtimes. Complete/dismiss preserve intent after rule changes; no background rewrite moves a stored instant. A disposable-database test replaces the current-rule validator with rejection and proves terminal commands still succeed while metadata replacement fails.

Owner is nonnull and defaults to the creator. New/changed ownership requires an active exact-client reminder viewer; unchanged ownership is historical and survives disabling/revocation. Neither ownership nor authorship authorizes a read/write. Optional resource references require their independently authorized, nonarchived exact-client target when newly linked, but historical IDs survive revocation/archive. Milestone links also retain their original parent. Responses never expand referenced data. Completed resource status is independent of reminder lifecycle.

Pending reminders alone can change metadata, complete or dismiss. Every write requires current view plus create/update and an active client, acquires the existing authorization lock, checks fresh state and commits one safe typed audit event atomically. Twelve lock-wait cases cover revoked/disabled actors/owners, client/resource archival, independent-resource permission revocation and positive resource completion. Private tables/helpers and composite foreign keys enforce the storage boundary.

Migration 9 adds three keys to the catalog (29 total), explicitly seeding Initial Administrator only. The minimal frontend known-key addition keeps existing identity/admin flows compatible; reminder product screens are separately reviewed. Rollback refuses all reminder records/events and custom/revoked grant history, while unused down/up preserves prior populated domains. Runtime grants must be reapplied after recreation.

Notification integration is a documented service commit boundary for a later transactional outbox/adapter. No sender, worker, recurrence or delivery-success field is wired. A due view describes actual pending UTC schedules only.

- [[Planning Interface and Reference Drafts]]
- [[Planning Lifecycle and Historical Task Links]]
- [[Task State and Assignee Scope]]
