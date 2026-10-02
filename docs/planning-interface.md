# Client planning interface

Related Issue: [#17](https://github.com/theroisey/else/issues/17). This frontend slice consumes the owner-merged [planning API](planning.md), PR #52 at `b7b7e95`. The [frontend scope](https://github.com/theroisey/else/issues/17#issuecomment-5947085377) was recorded before implementation. Owner merge of PR #53 at `60c8c59` closed #17.

## Routes and access

- `/app/clients/:id/plans`: plans, title/state/archive filters, UUID ordering and cursor pagination.
- `/app/clients/:id/plans/new`, `/app/clients/:id/plans/:planID`, and its `/edit` route: creation, detail and complete metadata editing.
- `/app/clients/:id/plans/:planID/milestones`: milestones of that exact plan, with equivalent filters and pagination.
- The milestone list's `/new`, `/:milestoneID`, and `/:milestoneID/edit` routes: creation, detail and metadata editing.

Every page requires effective `planning.view` for the exact client. Create additionally requires `planning.create`; metadata, status and links require `planning.update`; archival requires `planning.archive`. No aggregate planning permission, role-name check or authorship exception exists. IDs and parent relationships are validated before accepting API responses. Guarded routes load lazily, and login return paths accept validated route IDs without private query/form values.

Client Overview and Tasks offer Planning when authorized. Planning-only deep links work without `clients.view` or task access: no client-profile, task-detail, candidate or general user-directory request is made. Client context is optional and independently authorized; when available, archived clients disable writes. The backend always rechecks the client state. Every milestone page fetches the authorized parent plan; an archived, terminal, loading or failed parent disables child changes while preserving drafts and readable history.

## Lists and explicit lifecycle

Lists use semantic, keyboard-scrollable tables, fixed 25-record pages and server UUID cursors. Applying literal title, state, current/archived/all or ID-order filters resets Previous/Next history. There are no invented totals or client-wide unbounded fetches. Loading, empty, safe error/retry, denied, disabled and success states are explicit.

Separate status controls expose only the documented plan/milestone transition matrices. Plans start as draft; milestones start as planned. Completion remains manual and independent of linked tasks and child milestones. Server completion/cancellation timestamps disappear after reopening. Terminal metadata and task-link changes require reopening first; a terminal parent must itself be reopened before child changes. Archival captures the current target revision, opens a confirmation with initial Cancel focus, and retains children, descriptions, states and link history. Success requires the returned target ID and incremented revision.

## Metadata and timestamps

React Hook Form keeps drafts in memory. Zod applies the API's normalized Unicode title/description bounds, plain-text control rules, valid timestamps and date order. Plans replace title, description, start and due metadata together; milestones replace title, description and due, omitting `start_at`. Status, authorship, terminal markers and task references are separate operations. Milestone due times are checked against the currently supplied parent boundaries; the server also checks plan-date edits against nonarchived children.

Dates display and edit in the device's stated IANA timezone. Changed local inputs convert to UTC; invalid dates and spring-forward gaps fail validation. A changed repeated-hour time uses the browser's first occurrence, explained beside the controls. Unchanged fields preserve the original timestamp string, including microseconds and a later overlap occurrence. Tasks and Planning share these helpers without changing task due indicators. Dates never schedule reminders or automatically change state.

Captured target revisions prevent silent overwrites. Conflicts keep metadata drafts and disable another save until explicit reload/discard. Background refresh failures preserve the form and disable writes. Parent refreshes keep drafts mounted. Reload fetches the current baseline and checks authorized parent context; archived or terminal targets stay readable and cannot be edited.

## Task references and privacy

Milestones hold at most 50 distinct task IDs. The link editor owns the complete selected set independently of candidate pages, searches, loading and errors. Saving replaces the full set, including an explicit empty array. Metadata/status/archive controls are withheld while link editing is open. Revision conflicts retain selections and require explicit reload of current references.

Existing references are shown as IDs, with task deep links only when independently authorized. Planning detail and history never contain task titles or states. Removed links remain dated history; relinking creates another historical row. The paged history table filters current, removed or all references and displays task ID, linked time and removed time only.

Candidate discovery runs only during permitted editing, with task view and an active parent. Its paged response supplies active same-client task ID/title/status only. Selected IDs survive paging/search/errors, and the UI prevents a 51st reference. The save rechecks eligibility: tasks archived after discovery are rejected safely and the selection remains editable. Unchanged historical references can be retained or explicitly removed after task archival or loss of task view. Revoking task view immediately removes cached candidate titles and task links while retaining IDs; newly selected IDs must be removed before saving with planning permission alone. Linking never changes task status or grants task access.

## Sessions and audit

Planning reuses the existing cookie/CSRF transport and shared record-operation lifecycle. Query keys partition actor, grant snapshot, exact client and plan/target context. Completed reads reject identity/grant changes; late mutation results from unmounted routes cannot navigate. Metadata placeholders are reused only for the same actor within a mounted scope and still require planning permission. Private queries clear on logout/expiry, and reduced grants use new query keys. Drafts and selections never enter browser storage, navigation filters, logs, mutation caches or client audit payloads.

The existing API writes `plan.created/updated/archived` and milestone equivalents atomically with safe existence/revision/status snapshots. Status and link writes use `updated`. Rejected writes emit no successful event. This slice changes no backend source, schema, permission definitions, migration, runtime grants or audit policy.

## Verification

Local lint, strict typecheck, production build and 127 Vitest tests pass; the production dependency audit reports zero vulnerabilities. Planning coverage includes exact-client view-plus-write access, wrong-parent responses, safe returns, Unicode/date validation, manual transitions/reopening, confirmations, stale metadata/link drafts, background refresh failures, grant revocation, retained references, candidate paging failure/retry/search reset, the 50-reference ceiling and late-route mutation rejection. Shared daylight-saving tests verify gaps, overlaps and unchanged microseconds.

Seven Playwright flows exercise the real API against a fresh disposable PostgreSQL 17.11 database, including the new planning flow. It verifies 25-record pagination, creation/editing, a competing revision, parent date windows, candidate paging, archived-task rejection, planning-only access in America/New_York, unlink/relink history, manual parent/child lifecycle, confirmed archive, task state independence, empty browser storage and actual audit event counts/order. Desktop (1440px), tablet (820px) and mobile (390px) captures use clearly labelled synthetic fixtures. Local race-enabled Go unit and PostgreSQL integration suites pass. CI supplies PostgreSQL 18, pinned Chromium and container gates before review readiness.

- [Plans desktop](screenshots/planning-desktop.png), [tablet](screenshots/planning-tablet.png), [mobile](screenshots/planning-mobile.png).
- [Plan form mobile](screenshots/planning-form-mobile.png), [task picker mobile](screenshots/planning-picker-mobile.png).
- [Milestone links desktop](screenshots/milestone-links-desktop.png), [mobile](screenshots/milestone-links-mobile.png).
- [Archive confirmation mobile](screenshots/planning-archive-mobile.png).

No production deployment or agent merge is performed. Reminders, comments/attachments, aggregated dashboards and scheduling remain separate roadmap Issues.
