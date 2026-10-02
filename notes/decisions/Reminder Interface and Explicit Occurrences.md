---
type: decision
status: frontend-review
created: 2026-10-02
tags:
  - reminders
  - frontend
  - authorization
  - timezones
---

# Reminder Interface and Explicit Occurrences

Issue #18's interface follows owner-merged backend PR #54 at `59e0aa2`. Both permanent development branches were synchronized before source edits. Main [run 36994556915](https://github.com/theroisey/else/actions/runs/36994556915) passed all five gates and tested-image publication. The [frontend contract](https://github.com/theroisey/else/issues/18#issuecomment-5950220351) was recorded first. The [interface guide](../../docs/reminder-interface.md) documents the consumer behavior; owner merge closes #18. Agents do not merge or deploy.

Native datetime-local controls can erase original microseconds. Reminder forms instead pair a date control with plain `HH:mm:ss[.ffffff]` input and an explicit named IANA zone. Browser Intl finds nearby offsets and round-trips candidate instants. New repeated-hour schedules require a deliberate Earlier/Later selection; gaps/skipped dates never normalize. UTC previews retain microseconds and historical offset seconds. A timezone change retains wall-clock input and clears the new occurrence choice. Existing canonical wall clock/offset survives unchanged metadata edits; choosing the other fold is an explicit supported edit.

Stored intent is arithmetic history, independent of browser timezone updates. Unchanged records remain displayable when current browser rules disagree; the backend still validates full metadata replacement against current Go/PostgreSQL rules. Rejections preserve drafts. Completion/dismissal never reinterpret schedules. Due badges come from actual server reads, with explicit refresh and no claim of notification delivery.

Owner and resource selections live outside candidate pages. Historical owners keep IDs after disabling/revocation/directory failure. Candidate titles require independent related-domain view; permission revocation hides titles/browsing immediately and retains draft IDs. New unauthorized references must be cleared or restored to the original ID before saving. Resource clearing/restoring must clear its unregistered React Hook Form error, otherwise handleSubmit can retain a blocking error after the reference is valid again; the routed regression checks this sequence.

Exact-client reminder-only routes never fetch other private domains without permission. Terminal/known archived contexts are read-only, dismissal is Cancel-first, and every mutation captures a revision and checks server-confirmed ID/increment. Conflicts require explicit reload/discard. Background reads retain drafts and disable writes on failure. Shared record operations partition actor/grants/client, prevent departed-route navigation and clear private data at session expiry/logout.

159 frontend tests, complete race-enabled Go/PostgreSQL regressions, eight real-API browser flows, dependency audit and responsive synthetic screenshot checks verify the slice. Local PostgreSQL 17.11 is disposable; CI verifies PostgreSQL 18 and containers before readiness. No new dependency or backend/migration/audit/notification implementation is added.

- [[Reminder Timezones and Historical Ownership]]
- [[Planning Interface and Reference Drafts]]
- [[Task Interface and Timestamp Editing]]
- [[Application Shell and Session Recovery]]
