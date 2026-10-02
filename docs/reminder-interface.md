# Client reminder interface

Related Issue: [#18](https://github.com/theroisey/else/issues/18). This slice consumes owner-merged [reminder API](reminders.md) PR #54 at `59e0aa2`. The [frontend contract](https://github.com/theroisey/else/issues/18#issuecomment-5950220351) was recorded before source edits. Both permanent development branches were synchronized; main [run 36994556915](https://github.com/theroisey/else/actions/runs/36994556915) passed all five gates and tested-image publication. Owner review and merge of this frontend slice closes #18.

## Routes and scoped access

- `/app/clients/:id/reminders`: bounded table and filters.
- `/app/clients/:id/reminders/new`: creation.
- `/app/clients/:id/reminders/:reminderID`: detail and explicit lifecycle controls.
- The detail route's `/edit`: complete metadata replacement with a captured revision.

Every route requires current `reminders.view` in the exact client. Creation additionally requires `reminders.create`; editing, completion and dismissal require `reminders.update`. No owner, creator or role-name exception grants access. Reminder-only deep links work without client-profile, task, planning or general-directory reads. Independently authorized client context is optional; an archived/loading/failed known client disables writes while preserving readable records and drafts. Backend checks remain authoritative.

Overview, Tasks and Planning provide a Reminders link only when authorized. Reminder pages provide their independently authorized module links. Lazy page loading has loading/reload boundaries, breadcrumb context and validated login return paths. Private filter/form values never enter return paths or browser persistence.

## Tables and lifecycle

The semantic, keyboard-scrollable table uses fixed 25-record UUID cursor pages with Previous/Next. Filters cover literal title, pending/completed/dismissed/all, all/due/upcoming schedules, anyone/me/owner UUID including historical ownership, and ascending/descending ID. Apply resets the cursor. No unbounded fetching or invented totals are used. Loading, empty, safe failure/retry, denied, disabled and success states are explicit.

Due badges come from the server's pending schedule comparison. Refresh requests current records; no background notification or delivery result is implied. Stored original wall clock, named zone, selected offset and available microseconds are displayed together; detail also shows the UTC instant. Completion and dismissal use the captured revision and server-confirmed result. Dismissal opens a Cancel-first confirmation; conflicts require cancel/refresh before another attempt. Terminal records and direct terminal edit routes remain read-only. Reminder commands never change resource status.

## Dates, zones and explicit occurrences

Creation defaults to the device's stated IANA zone, with an empty date and a visible editable local time. The form pairs an accessible date input with a plain `HH:mm:ss[.ffffff]` time input: native datetime-local controls must not discard PostgreSQL microseconds. Minute-only input normalizes seconds to zero; dates, controls, calendar/year bounds and precision are validated before transport. Past schedules are valid and due immediately.

The timezone is explicit and editable. Browser Intl obtains nearby offsets and accepts only choices that round-trip to the exact wall clock in that zone. Ordinary local times have one occurrence. A repeated hour displays Earlier/Later radio choices with numeric UTC offset and exact UTC preview; no occurrence is silently selected for a new schedule. Non-hour transitions, historical second offsets and skipped dates are handled. Invalid/nonexistent local times cannot submit.

Changing a timezone retains the typed wall clock, clears a newly chosen occurrence and presents the resulting UTC instant for review. Selecting a valid occurrence clears its prior validation error. Original schedules retain canonical wall clock, offset and microseconds on unchanged metadata saves; users can deliberately choose the other occurrence without changing the wall clock. An unchanged recorded schedule remains representable if newer browser rules disagree. The Go/PostgreSQL writer still checks every full metadata replacement against current server rules and may return a safe schedule error. Such failure preserves the draft; there is no automatic reinterpretation or migration of existing instants.

## Owners and optional resource references

Owners use only the paged reminder owners endpoint, exposing eligible IDs and display names. The selected owner is independent of the current page and persists through paging or directory failure. An unavailable historical owner is represented by its recorded ID; the form does not invent a current name or silently reassign ownership. Owner selection is disabled on directory failure, but an unchanged historical owner can still be retained in a metadata save.

Task/plan/milestone candidates use independently authorized, bounded existing APIs. Milestones first choose a nonarchived parent plan, then browse its children. Candidate titles are visible only with current related-domain permission. The chosen reference lives outside candidate pages and searches as kind/ID; detail never expands resource data. Tasks/plans offer deep links only with independent permission; milestone IDs remain references because the reminder contract does not expose their parent route ID.

Archival or related-permission revocation preserves historical references. Clearing needs reminder update alone. Revocation immediately hides candidate titles and browsing, preserving draft IDs. A newly selected reference without current independent access must be cleared or the recorded reference restored before saving. Clearing/restoring also clears its prior validation error. Backend checks repeat resource eligibility, client/parent relationships and current permissions after lock waits.

## Drafts, conflicts and private data

React Hook Form keeps metadata drafts in memory and captures the initial record revision. Background reads preserve the mounted draft; loading or failure disables writes. A conflict blocks further saving until explicit reload/discard. Reload checks fresh data, refreshes authorized client context, and disables editing if the reminder has become terminal. Reload failures preserve the draft.

The existing record-operation helper now supports the reminders domain, partitioning queries by actor, grants and exact client. Permission guards run before display; related candidate titles have no placeholder data across grant changes. Authorized reminder metadata can remain a same-actor placeholder during a grant refresh within the mounted route, preserving the draft. Old route/actor/grant results cannot display or navigate; expiry/logout clears private queries. Only reviewed metadata is serialized, and mutation responses must confirm the target ID and exact incremented revision. Response validation checks client/target scope, UTC/wall/offset arithmetic, microsecond/year bounds, lifecycle markers and bounded unique pages without reinterpreting historical zone rules.

## Verification and screenshots

159 frontend tests include 32 reminder checks covering explicit folds/gaps, half-hour/quarter-hour/historical-second offsets, skipped dates, host-zone independence, arithmetic/precision/year validation, return routes, view-plus-write scope, bounded pages, directory history/failure, resource privacy and revocation, conflict/background drafts, terminal commands, Cancel-first focus, archived context, session expiry and departed-route responses. Lint, typecheck, production build and production dependency audit pass with no added dependency. The complete race-enabled Go/PostgreSQL regressions preserve the owner-merged API.

Eight real-API Chromium flows include reminder creation with explicit later occurrence/microseconds, disabled-owner retention, concurrent conflict/reload, spring-gap rejection, deliberate earlier occurrence, archived/revoked task retention, manual completion, actual due/owner filtering, confirmed dismissal and immutable terminal views. Synthetic screenshots are checked at desktop/tablet/mobile widths with horizontal overflow assertions. Traces, video and credential capture remain off. Local PostgreSQL 17.11 is disposable; final-head CI verifies PostgreSQL 18, containers and all browser flows before readiness.

- [Reminder table desktop](screenshots/reminders-desktop.png), [tablet](screenshots/reminders-tablet.png), [mobile](screenshots/reminders-mobile.png).
- [Explicit occurrence form desktop](screenshots/reminder-form-desktop.png), [mobile](screenshots/reminder-form-mobile.png).
- [Nonexistent-time validation mobile](screenshots/reminder-gap-mobile.png), [dismissal confirmation mobile](screenshots/reminder-dismiss-mobile.png).

No backend/API, schema, runtime grants or audit-policy change is introduced. No notification sender, recurrence, production migration, deployment or agent merge is performed.

Owner-merged [PR #55](https://github.com/theroisey/else/pull/55) completed #18 at `0194e8c`; main [run 37001360296](https://github.com/theroisey/else/actions/runs/37001360296) passed all gates and tested-image publication before [activity](activity.md) began.
