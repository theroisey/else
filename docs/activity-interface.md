# Client activity interface

Related Issue: [#22](https://github.com/theroisey/else/issues/22). This frontend consumes owner-merged [activity API](activity.md) [PR #56](https://github.com/theroisey/else/pull/56) at `d507f68`. Both permanent branches were synchronized before source edits. Main [run 37005708004](https://github.com/theroisey/else/actions/runs/37005708004) passed all five gates and tested-image publication. The [frontend contract](https://github.com/theroisey/else/issues/22#issuecomment-5952256431) was recorded first. Owner review and merge of this interface closes #22.

## Route and access

`/app/clients/:id/activity` is a lazy, read-only workspace page. Validate the client UUID before private requests. Breadcrumbs and validated login return paths recognize this destination; cursors, query strings and new/edit paths are not return destinations.

Require both current `clients.view` and `activity.view` for the exact client, including applicable global grants. Overview, Tasks, Planning and Reminders offer Activity only with both grants. The timeline offers related module links only with independent view grants. Client-profile access alone does not imply activity access.

The feed makes no client-profile, resource-detail, actor, owner or directory request. Client identity is the route ID. Rows show reviewed summary, resource kind/reference ID and exact recorded UTC time. References remain plain text, including archived resources and milestones without parent-plan IDs. No titles/actors are expanded; there are no write controls. Archived clients remain readable when the backend permits them.

## Projection and validation

Consume only event ID, client ID, UTC occurrence time, reviewed event type, resource kind, resource ID and static summary. Accept eighteen reviewed lifecycle types with their exact server-owned English summaries. Reject unknown fields at event/page/envelope levels, unreviewed security/domain events, mismatched kinds/clients, invalid or zero UUIDs and inconsistent client references before rendering. Contract expansion requires a deliberate consumer update.

Validate calendar dates, UTC syntax, years 0001–9999 and at most six fractional digits. Semantic `time` elements display original timestamps without truncating microseconds. Ordering uses the shared microsecond comparator and descending UUID ties; duplicate IDs and out-of-order rows fail safely. Snapshots, profile text, contacts, actors, schedules, revisions and source/correlation metadata never appear. No event is inferred from current state.

The server repeats authorization on every read. The consumer also filters rows against known current permissions: tasks require `tasks.view`, plans/milestones require `planning.view`, reminders require `reminders.view`, and client events require both root grants. Backend checks remain authoritative before the browser refreshes a revoked grant.

## Pagination, refresh and failure

Request exactly 25 events. Previous/Next retain a history of unchanged opaque cursors in memory. Cursor syntax/length and page size are bounded; continuation requires a full page and cannot repeat the current cursor. No totals, offsets, unbounded accumulation or browser persistence are introduced.

Refresh activity resets to the newest first page and requests a fresh result. Returning to an earlier page also revalidates it. Each page reflects current permission checks and a database statement snapshot, not a snapshot spanning requests. New commits above the boundary appear after refresh; late commits with older timestamps can appear on later pages. Access changes can change page contents.

Shared record operations partition queries by actor, grants and client and reject departed/changed-context results. Known grant/actor changes remount the timeline and reset cursors. No placeholder rows cross those boundaries. Pending reads hide previous rows. Failed reads, including background failures and invalid payloads, suppress cached rows until a valid read succeeds. Existing session expiry/logout clears private queries; server 401/403/404 responses refresh session access. Root revocation removes the timeline; known domain revocation removes its rows and links immediately.

Loading, permitted empty, denied and safe error/retry states are explicit. Retry rechecks the current page; Refresh activity returns to the beginning. Controls are disabled while fetching. Semantic navigation/list controls and responsive rows preserve long IDs/timestamps without horizontal overflow.

## Verification and screenshots

195 frontend tests pass, including 36 activity checks for lifecycle labels, field redaction, calendar/microsecond/order validation, page bounds, return paths, scope, no unrelated reads, loading/empty/retry, opaque pagination, first-page refresh, background failures, grant/actor changes, late results and server-side denial. Lint, typecheck, production build and production dependency audit pass with zero vulnerabilities and no added dependency.

All nine real-API Chromium flows pass. Activity creates 26 client updates, a task and a client archival through authenticated business APIs, then checks pagination, refresh, archived-client history, metadata rejection/retry, domain/root revocation and unchanged client audit counts during reads. It never inserts or changes audit events to prepare this test. Synthetic private profile/task text exists in business records but is absent from rendering. Request assertions exclude unrelated detail/directory reads.

Desktop (1440), tablet (820) and mobile (390) screenshots are visually checked with horizontal overflow assertions. Images contain isolated synthetic data. Traces, videos and credential capture stay off.

- [Timeline desktop](screenshots/activity-desktop.png), [tablet](screenshots/activity-tablet.png), [mobile](screenshots/activity-mobile.png).
- [Permitted empty state](screenshots/activity-empty.png), [malformed-response error mobile](screenshots/activity-error-mobile.png).

Complete race-enabled Go/PostgreSQL regressions preserve the owner-merged API. Local PostgreSQL 17.11 is disposable; final-head CI verifies PostgreSQL 18, containers and all nine browser flows before readiness. No backend/schema/runtime-grant/audit-policy change or production migration/deployment is introduced. Agents do not merge.

Owner-merged [PR #57](https://github.com/theroisey/else/pull/57) at `1a30014` completed #22. Main [run 37011258324](https://github.com/theroisey/else/actions/runs/37011258324) passed all gates/publication; both branches were synchronized before [audit reads](audit-reader.md) (#28).
