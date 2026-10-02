# Authorized audit inspection interface

Related Issue: [#28](https://github.com/theroisey/else/issues/28). This frontend consumes the owner-merged [audit-read API](audit-reader.md), [PR #58](https://github.com/theroisey/else/pull/58) at `45db4b1`. Both development branches were synchronized before source edits. Main [run 37016592527](https://github.com/theroisey/else/actions/runs/37016592527) passed all five gates and tested-image publication. The [frontend contract](https://github.com/theroisey/else/issues/28#issuecomment-5954097210) was recorded before implementation. Owner frontend review/merge completes #28.

## Routes, scope and navigation

`/app/audit` opens global visible history with current global-only `audit.view`. `/app/clients/:id/audit` additionally requires current `clients.view` for the exact valid client UUID. Applicable global client-view grants work; a client-scoped audit grant does not confer the root capability. Global events remain readable by a global audit-only viewer; client-linked events additionally require current client visibility. The server repeats active-user, real-client and current-grant checks on each list/detail statement. Archived history remains inspectable.

The shell registers Audit history only with the global capability. Accessible client overviews offer their exact audit destination. Breadcrumbs, lazy-page failure/loading boundaries and validated login return paths recognize both pages; filter/cursor query strings and new/edit paths are excluded from return destinations. Audit access deliberately exposes safe cross-domain markers inside visible clients without domain-view grants. Activity retains its separate narrower business policy.

Reads request only audit endpoints and session refresh; no client profile, user, actor, owner or resource-directory lookup is added. Actor/client/resource IDs remain plain historical references and do not imply current resource availability. No edit/delete or audit mutation control exists.

## Exact filters and pages

The filter form supports actor UUID/kind, event type, client UUID (global route only), resource kind/UUID, recorded request ID, inclusive From and exclusive To UTC instants. Fields apply together on submit; drafting changes sends no private request. IDs normalize lowercase; optional empty fields are omitted. Validate nonzero UUIDs, reviewed event syntax, bounded kind/base32 request strings, real UTC calendar dates, years 0001–9999 and at most six fractional digits. A supplied date pair must increase at microsecond precision. Date fields preserve exact UTC strings rather than passing through millisecond-only local date controls. An inaccessible selected client is blocked locally with filter recovery; backend policy remains authoritative.

Request 25 rows and validate bounded, unique descending timestamp/UUID order. Rows must match applied filters and route context; detail must match all ten fields of its immutable selected summary. Previous/Next retain unchanged opaque cursors in memory; malformed/overlong/repeated continuations fail safely. Applying/clearing filters, refreshing or changing actor/grants/client resets pagination and details. Refresh retains applied filters and returns to the newest first page. No totals, offsets, infinite accumulation, export or browser persistence is added. Each page reflects current access and statement consistency, not a snapshot spanning requests.

## Safe detail and differences

Lists validate exactly the ten summary fields before rendering. Schema version 1, actor nullability, reviewed event/kind relationships, correlation references and exact timestamp precision must agree. Unknown fields/envelope expansions fail safely. Lists never show snapshot/source metadata or free text.

Inspect event opens the shared semantic modal dialog with a descriptive audit heading. It performs a fresh GET-only detail read. Strict detail validation accepts only reviewed existence/revision/status/task/planning/reminder markers and the `http`, `job` or `cli` source enum. Validate marker kinds/states, paired reminder UTC/zone fields and canonical decimal revision strings up to 9223372036854775807. No title, description, profile/contact, actor email/name, token, password, driver cause or arbitrary metadata enters the rendered projection.

The difference table enumerates only the eight reviewed marker keys and includes changed present values. Missing markers show “Not recorded”; boolean values show Yes/No. Revisions stay strings without JavaScript number conversion; timestamp and named-zone strings stay exact. Status values receive readable spacing. Unchanged markers produce no invented changes. Null, empty and recorded snapshots have separate state labels, including null-to-empty transitions with no marker differences. A collapsed detail section contains only validated raw safe snapshots/source metadata.

The modal traps focus, supports Escape, retains a Close details control while loading/failing and restores focus to its inspect trigger after closing. Long references wrap; semantic tables scroll inside focusable labeled regions on small screens. Dialog content scrolls within the viewport. No mutation is implied by inspection.

## Private-data lifecycle and errors

The shared record lifecycle partitions audit queries by actor, current grants and client scope. Known changes remount the reader, reset filters/cursors/selection and reject late results from departed contexts. Local policy also suppresses no-longer-visible client rows. Pending list/detail reads hide cached records. Failures, including background errors and malformed successful payloads, suppress cached private data until a valid read succeeds. Closing a pending dialog never reopens it when its response arrives.

Server 401/403/404 failures recheck the session, removing revoked root/client access and navigation. Existing expiry/logout clears private queries. Safe errors come from stable codes; server messages/SQL causes are not rendered. Loading, permitted empty, inaccessible filter, denied, service/contract error and retry states are explicit. Retry rechecks the current request; Refresh restarts chronology. Controls disable during active list reads.

## Verification and visual evidence

219 frontend tests pass, including 24 audit contract/permission/filter/precision/safe-difference/component checks. Coverage includes scoped global-key exclusion, independent client access, hostile/expanded summary/detail/snapshot/source payloads, int64 maximum, absent/empty/unchanged markers, microsecond date/order boundaries, route/filter/detail mismatches, opaque pages, filter recovery, background failures, actor/grant changes, closed/late dialogs, server revocation and keyboard focus. Lint, strict typecheck, production build and production dependency audit pass with zero vulnerabilities and no added dependency.

All ten real-API Chromium flows pass. Audit verification creates 26 tasks and an update through authenticated audited business APIs, then tests all exact filters, first-page refresh, opaque paging, inclusive microseconds, detail/differences, raw safe metadata, focus trapping/restoration, safe retry, domain/client/root revocation and unchanged full audit-history hash during reads. It inserts no synthetic audit events and never rewrites/deletes history. Real private fixture titles/descriptions remain absent. Read assertions exclude unrelated profile/directory expansion.

Desktop (1440), tablet (768) and mobile (390) screenshots use explicitly isolated synthetic data, with document overflow assertions and visual inspection. Traces, videos and credential capture stay off.

- [Table desktop](screenshots/audit-desktop.png), [tablet](screenshots/audit-tablet.png), [mobile](screenshots/audit-mobile.png).
- [Detail desktop](screenshots/audit-detail-desktop.png), [detail mobile](screenshots/audit-detail-mobile.png).
- [Empty state](screenshots/audit-empty.png), [safe error](screenshots/audit-error-mobile.png).

Local PostgreSQL 17.11 is disposable. Final-head CI verifies PostgreSQL 18, Go regressions, containers, frontend and all ten browser flows before readiness. This slice changes no backend/schema/runtime grant, permission catalog/seed, dependency or audit-writing policy. No production migration, merge or deployment is performed.
