---
type: decision
status: frontend-review
created: 2026-10-02
tags:
  - tasks
  - frontend
  - authorization
  - timezones
---

# Task Interface and Timestamp Editing

Issue #16 follows owner-merged backend PR #50 at `9b42a90`. Both permanent development branches were synchronized; main run 36959187201 passed all five gates and tested-image publication. No deployment was performed. The task UI scope and DST policy are linked from [the interface contract](../../docs/task-interface.md).

Task pages require exact-client task view independently of client-profile access. View plus granular create/update/delete, or legacy manage, controls writes. Task-only deep links deliberately avoid optional client reads and general directories; only authorized parent context can report archival. Otherwise write-time API checks remain authoritative. Overview links to Tasks only with task view; remaining modules stay unavailable. No global task entry or inferred activity is introduced.

Lists use fixed 25-record UUID cursor pages and actual API filters, held in memory. Status transitions and archive use dedicated endpoints, captured revisions and server-confirmed results. Terminal metadata requires reopening. Archive retains history. Shared record operations now reject late identity **and grant** changes, partition caches by actor/grants/client, refresh revoked sessions/access and preserve safe errors. Existing client tests cover the extraction as well.

RHF/Zod replace complete metadata only. Candidate paging returns ID/display name, preserves a selected value across pages/loading/error and retains unchanged historical assignees until explicit clear/change. Optional parent refresh must not unmount drafts or force a disabled query without client view. Conflicts keep drafts until explicit reload/discard.

Device IANA timezone is explicit in display/forms. Changed local dates convert to UTC, invalid/gap times fail and changed overlap times use the browser's first occurrence. Unchanged local fields return the original timestamp string before conversion, preserving PostgreSQL microseconds and a later overlap occurrence. Native datetime-local inputs can omit zero seconds, so compare normalized values. Overdue and next-24-elapsed-hour indicators compare microsecond instants, exclude terminal/archive states and refresh periodically/on focus. Dates never auto-transition or schedule tasks.

Real mobile browser checks exposed off-screen absolute screen-reader labels inside inline table forms. Positioning the existing Table's scroll wrapper relative anchors those labels and keeps horizontal overflow inside the keyboard-scrollable region; hiding accessible labels is unnecessary.

97 frontend tests and six real-API browser flows verify the UI and audit outcomes. Local PostgreSQL 17.11 is disposable; CI remains responsible for PostgreSQL 18, pinned Chromium and container gates before readiness. Browser captures contain labelled synthetic records only; traces/video and credential-bearing artifacts remain off. Planning/reminders/comments/attachments are separate Issues.

- [[Task State and Assignee Scope]]
- [[Client Interface and Workspace]]
- [[Application Shell and Session Recovery]]
- [[Interface Foundation]]
