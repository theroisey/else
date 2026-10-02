# Client task interface

Related Issue: [#16](https://github.com/theroisey/else/issues/16). Consumes the owner-merged [task API](tasks.md), with no schema, API, permission or audit-policy changes. The [implementation policy](https://github.com/theroisey/else/issues/16#issuecomment-5944989176) and [daylight-saving clarification](https://github.com/theroisey/else/issues/16#issuecomment-5945112637) were recorded before implementation.

## Routes and permissions

- `/app/clients/:id/tasks`: task table, filters, cursor pagination and permitted inline actions.
- `/app/clients/:id/tasks/new`: complete metadata form, initially backlog or todo.
- `/app/clients/:id/tasks/:taskID`: description, state, dates and record context.
- `/app/clients/:id/tasks/:taskID/edit`: complete metadata replacement for an active, nonterminal task.

Every page requires effective `tasks.view` for the exact client. Create also requires `tasks.create`, editing/transitions require `tasks.update`, and archival requires `tasks.delete`; legacy `tasks.manage` supplies the write capabilities but never view. Creator/assignee and role names grant no access. Wrong-scope and malformed deep links are guarded before domain reads. Safe login return paths contain validated IDs and route segments, never filters or form values.

Client Overview shows Tasks only with exact task view. Task-only users can enter through a deep link without fetching a client profile, general user directory or assignee candidates. Optional parent context loads only with exact `clients.view`. A known archived client disables changes. Without that permission, the backend enforces the parent state on every write; the interface does not infer a client status from a task. Task history remains readable after archival. There is no global task list, restore, comments, attachments, kanban or invented activity stream.

## Tables and actions

The semantic table displays API summaries: title/tags, state, priority, due time/indicator, assignee reference and permitted actions. Unknown assignee names remain an ID prefix; only the eligible picker supplies authorized display names. Filters match literal title search, exact normalized tag, seven states, four priorities, anyone/me/unassigned, active/archived/all records and UUID ascending/descending order. Applying filters resets cursor history. Previous/Next follows server cursors with limit 25 and no invented totals. Filters stay in component memory; the API's documented GET query carries them without putting them in navigation or return URLs.

Status controls offer only the [explicit transition matrix](tasks.md). Terminal tasks expose reopening before metadata editing. Completion and cancellation markers come from the server and disappear after reopening. Archive opens a confirmation for the captured task/revision, initially focuses Cancel, and retains description, state and history after success. Rejected status/archive attempts show safe messages and require a reload/review before another write. Success follows confirmed target ID and incremented revision, never an optimistic local state.

Loading, empty, safe error/retry, denied, disabled and confirmed-success states are explicit. Background errors withhold previous task content. The shared Table now positions screen-reader-only inline labels inside its scroll region, preventing mobile page overflow while retaining keyboard horizontal scrolling.

## Forms, assignees and time

React Hook Form holds the metadata draft; Zod enforces the API's Unicode lengths, normalized distinct tags, control-character rules, seven states, four priorities and timestamp order. Description is plain text, permits line breaks and normalizes CRLF to LF. Tags use one label per line. The metadata PUT excludes status, creator, completion/cancellation and audit fields.

Eligible assignees use a bounded ID/display-name endpoint with independent 25-record pagination. Paging, loading and errors preserve the selected value even if it is absent from the current page or no longer eligible. Only an explicit clear/change alters an existing historical assignment; the backend rechecks eligibility at save time. No email directory or synthetic display name is added.

Dates display and edit in the device's IANA timezone, stated alongside the controls, and changed local values convert to UTC. Invalid calendar dates and nonexistent spring-forward times are rejected. During a repeated daylight-saving hour, a changed time uses the browser's first occurrence, explicitly explained beside the fields. An unchanged value preserves the complete original server timestamp, including its later overlap occurrence and microseconds. Dates are informational; they do not automatically change state or schedule a reminder.

An unarchived, nonterminal task is overdue at or before its due instant; due soon means the next 24 elapsed hours. Comparisons preserve PostgreSQL microseconds and offsets. Indicators refresh every 30 seconds and on window focus; done, cancelled and archived tasks have no overdue warning.

A stale revision preserves the draft and blocks another save until explicit reload/discard. Reload updates the baseline and revision, preserves historical references, and checks optional parent context only when authorized. Parent refetches keep an unsaved draft mounted. Archive/terminal changes discovered during reload offer an Open task link to readable context and prevent metadata edits.

## Session and data boundaries

Clients and tasks share `useRecordOperations`, the existing same-origin cookie/CSRF transport and safe error mappings. Query keys include actor ID, grant snapshot and exact client. Completed reads reject identity or grant changes before accepting data; expiry/logout clears private queries. Reduced permissions fetch under a new key. Drafts stay in memory and JSON write bodies, with no local/session storage, mutation cache, request logging or client-generated audit payload. Tasks render lazily through guarded routes and reuse the existing components without new dependencies.

## Verification

Local lint, strict typecheck, 97 Vitest tests, production build and production dependency audit pass (zero vulnerabilities). Task tests cover exact-scope/legacy capabilities, wrong-client responses/deep links, safe return paths, validation, bounded filters/cursors, empty/error/retry, stale drafts, historical assignees, candidate paging, transitions/reopening, confirmed archive, archived parent context, session expiry, revoked grants, late-response rejection, draft preservation during parent refresh, timezone offsets and DST gaps/overlaps.

Six Playwright flows exercise the real Go API against a fresh disposable PostgreSQL 17.11 database. The task flow covers 25-record pagination, overdue/soon states, creation and scoped assignment, a real competing metadata write, explicit reload, editing, completion/reopening/cancellation, task-only viewing in America/New_York, wrong-client frontend and API denial, confirmed archival, filtered history and actual audit event order. Screenshots use clearly labelled isolated synthetic data. Desktop/tablet/mobile checks cover contained layouts, keyboard table scrolling and Cancel focus. CI supplies pinned Chromium, PostgreSQL 18 and container verification. No merge or deployment is performed by the agent.

- [Task table desktop](screenshots/tasks-desktop.png), [tablet](screenshots/tasks-tablet.png), [mobile](screenshots/tasks-mobile.png).
- [Task form mobile](screenshots/task-form-mobile.png).
- [Task detail desktop](screenshots/task-detail-desktop.png), [mobile](screenshots/task-detail-mobile.png).
- [Archive confirmation mobile](screenshots/task-archive-mobile.png).
