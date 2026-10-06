# Preserved domain contracts

The versioned API and React response validators remain the compatibility boundary. Domain services enforce these rules inside current-authority transactions. Shared pagination is bounded (normally 25, at most 100), with stable keysets, strict duplicate/unknown query rejection and no invented totals. Client-bound denied/missing IDs normally share opaque 404; global administration denial remains independent.

## Identity and authority

Argon2id PHC parameters stay compatible; random session and CSRF values are stored only as digests. Sessions expire absolutely after 12 hours. Secure host-only HttpOnly/Strict session cookies plus exact Origin, JSON and session-bound CSRF protect mutations; readable CSRF cookies are separate. Insecure cookies require explicit loopback HTTP. Initial bootstrap succeeds only on an empty user table; no demo account, self-registration, password reset or MFA is implied.

The permission catalog retains 32 fixed keys after deliberate removal of the release checker. Role names have no authority. Global assignments can satisfy client permissions; exact-client assignments never confer global administration. Unknown keys/scopes deny. Delegation requires global `roles.manage` and effective control of every old/new delegated key. Built-in roles are read-only definitions. Disablement atomically revokes sessions and records audit; no self-disable or removal of the last globally authorized recovery administrator. Historical grants are retained, and legacy scope IDs never become invented client profiles.

Client creation uses global create and grants no access to its creator. Reads and mutations require their explicit keys; current view and write are independent contracts. Client replacement preserves revision/audit atomicity across ordered contacts/tags. Confirmed archive retains readable history, disallows new work/scoped assignments and has no hard delete or restore operation.

## Tasks, planning and reminders

Tasks use exact-client view for reads; granular create/update/delete or legacy `tasks.manage` authorizes writes without implicitly granting view. New/changed assignees must be active task viewers; unchanged ineligible references remain historical. The bounded picker separately requires view and a write capability. Seven states follow the explicit matrix in `tasks.rs`: self/omitted transitions deny, done reopens to in_progress, cancelled reopens to backlog/todo. Server completion/cancellation markers clear on reopen. Terminal metadata requires reopen; confirmed archive preserves state/tags/history. Dates do not trigger transitions.

Planning requires its view plus explicit create/update/archive for writes. Plan completion is manual and independent of tasks/milestones. Child mutations require a current active nonterminal parent; milestone dates fit supplied parent windows, including when changing parent dates. Archived children are history. Only milestones link tasks; complete replacements contain at most 50 distinct IDs. New links require independent task view and active same-client targets. Retained links survive archival/view loss; removed links get timestamps and relinking creates a new history row. Links expose IDs/times, never task metadata or authority.

Reminders require view plus create/update; ownership/authorship grants nothing. New/changed owners need active current reminder view; unchanged historical owners remain retainable. Schedule intent records canonical local wall clock, explicit IANA zone, explicit UTC offset and exact UTC microseconds. New/full metadata replacements round-trip through current server rules; repeated hours require deliberate occurrence selection and nonexistent/skipped times refuse. Completion/dismissal preserve stored intent even after timezone-rule changes. Pending is the only writable state; completed/dismissed are immutable. Due means schedule eligibility, not delivered notification. No recurrence/sender is implemented.

Optional reminder task/plan/milestone references independently validate changed target authority, same-client ownership and parent eligibility. Unchanged archived/revoked references can remain, and clearing needs reminder update alone. Responses retain only IDs; candidate names require independent domain view. Neither reminders nor planning change linked task state.

## Exact collections and payments

Currency is explicit and immutable per collection: USD/EUR/GBP/TRY exponent 2, JPY 0, KWD 3. Amounts/revisions are canonical integer strings, bounded int64 per obligation/payment. Aggregate strings may exceed int64; never use IEEE-754, default currency, FX or a multi-currency grand total. Amount edits are allowed only before payment and never for copied pricing obligations.

Payments are positive append-only rows, reject overpayment, and freeze the obligation amount. No negative payment/refund/reversal is inferred. Paid-on can be historical but not future. Status precedence is cancelled > paid > overdue > partially_paid > pending; overdue compares UTC due date strictly before today. Confirmed cancellation closes only an unsettled obligation, retains recorded payments and never implies refund/reopening. Cancelled obligation/payment totals are separate from active totals.

A client-scoped command UUID permanently binds original actor/revision/normalized payload. Identical committed retries under current required permissions return the original payment/current collection revision without another audit, including later archival/cancellation. Changed payload/actor/revision conflicts. Lost responses never justify new commands or automatic revision replacement; absence from a checked history page is not proof of noncommit.

## Immutable pricing and copied terms

A sheet's currency/exponent is immutable. Full versions/ordered lines are append-only; zero-priced lines/versions remain valid but collection copies require a positive total. Quantity uses six-decimal integer micros and discount/tax use 0–10000 basis points. Calculate positive half-up at each line step: base(quantity×unit / 1e6), discount(base×bps / 1e4), net, tax(net×bps / 1e4), total; then sum rounded lines. Costs use independent base rounding, are unknown if any line lacks cost, and are visible only with current pricing.manage. No proration, schedule multiplication or automatic invoice exists.

Initial effective dates may be historical; appended starts must be at least UTC today and prior start. Same-day higher revisions supersede earlier versions without rewriting them. Successor start derives an exclusive cap on the prior window. Select highest eligible revision before checking its original end; an expired selected version creates a gap, not a fallback to an older version. Multiple independent agreements may overlap.

Explicit pricing-to-collection copies require pricing.view + billing.view + billing.create, current sheet revision, a version effective on the nonfuture billing date and an exact command/payload. Retained copied terms freeze amount/currency immediately. Billing.view alone reads original copied lines/totals after pricing access loss or later edits. Costs, pricing notes and collection notes never enter snapshots. Exact replay returns the committed collection with its current revision; uncertain outcomes preserve the original command and require explicit reconciliation.

## Audit, activity and overview

Significant accepted domain/access/key/work transitions append their typed allowlisted event in the same transaction. Encryption reservation is deliberately a separate preceding commit and is never refunded. Audit rejects raw/duplicate/expanded/noncanonical markers, remains immutable and omits private text, costs, money/reference payloads, account identifiers and secrets from its safe reader. Read-safe fields are independently narrower than storage fields; revisions remain exact strings.

Global audit.view exposes global security events; client-linked events also require current clients.view. It can inspect safe cross-domain security markers without implying business-domain reads. Activity separately requires clients.view + activity.view and current domain views; it returns static labels and historical IDs without profile/actor lookups or inferred events. Chronological `(occurred_at,id)` cursors bind normalized client/filter context, preserve microseconds and are not signed authority or cross-request snapshots. Reads append no audit.

Overview is one bounded read transaction: compact client context, currency-separated finance, five-row due/upcoming task/reminder queues and safe recent activity. Fresh grants omit inaccessible modules entirely. It has no costs, private notes, expanded ownership, invented metrics or caller-defined clock. Client workspaces retain authorized archived history across all modules.

## Independent websites

Website records remain independent identifiers, not fetch targets. Reads use clients.view; management adds clients.update, archival clients.archive, and provider association adds integrations.manage. The legacy profile website stays byte-preserved for review and is not silently overwritten by an independent property edit. Primary selection demotes/audits the former primary atomically. Archived websites retain stored reports/bindings and disable mutation. Client-level general finance/tasks/pricing are not silently repartitioned or combined across websites. Provider/client/credential identity never moves with UI association.
