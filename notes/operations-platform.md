# Unified operations implementation

Baseline: `d0df486ac0198d55ee8a09a94b922f0441e9f377`, `theroisey/else`, main only. The October 2026 master specification supersedes the proposed checklist in `/workspace/else-is-akisi-ve-revizyon-listesi.md`. This document records the implemented policies and the regression coverage map; actual release results belong in the delivery report. Existing runtime evidence: [#135](https://github.com/theroisey/else/issues/135).

## Inventory and compatibility

Reuse current sessions, scoped role grants, clients/independent websites, tasks, planning, reminders, exact collections/positive payments, immutable pricing, safe audit, SQLite transactions, online recovery and in-process background services. Extensions implemented in the existing application: daily cross-brand work, team membership/brand responsibilities, technical request decisions, versioned deliveries/reviews/comments/private evidence, notifications, commercial collection-party/revenue sharing/internal settlements, payment reversals, recurring occurrences and billing periods. Do not introduce another customer balance, calendar, login, database or HTTP process.

Existing general tasks retain their lifecycle. A technical request has one explicitly linked task after acceptance; its task cannot bypass delivery review through the ordinary task API. Immutable request events and delivery versions retain human-readable discussion separately from redacted safe audit markers. Views and mutations freshly check capabilities and actual brand/site/team relationships. Developer self-review is denied, including owners; an independent authorized owner/leader remains a reviewer when the requester departs.

## Authorization policy

Add operational capabilities and nonfinancial built-in developer/advertising templates. Preserve existing Viewer/Finance/custom role definitions and historical assignments. Extend only the designated full administrator role with newly introduced capabilities; never infer privileges from a role's display name. Advertising employees receive `tasks.read_own`/`tasks.update_own`, not full-brand task reads or general edits. Only assigned independent tasks can change status with those capabilities; request-bound tasks still require their review workflow. Leaders see their own active teams unless independently granted full staff management. Brand assignments use existing scoped role grants and retain revocation history; leader delegation is bounded by team membership, brand authority and every delegated capability. Removing a responsibility revokes its owned grant, preserving unrelated explicit grants and original actors.

Request submission goes directly to the developer queue. The current flow is direct submission; an optional future leader-preapproval gate is not implemented or advertised. Reading own/team/all requests requires the corresponding capability plus current brand access; creator identity alone grants nothing. Notifications and evidence recheck destination access on every read. Financial notifications have no monetary payload and require current finance access.

## Evidence and recovery policy

Private evidence is stored as bounded SQLite BLOBs, not public static files. This keeps transaction rollback, online backup and empty-target restoration coherent without a second file manifest. Accept verified PNG/JPEG/WebP images and PDF documents, reject SVG/HTML/executable content, cap each at 8 MiB, each request at 32 files/64 MiB and installation at 2 GiB. Original filenames are reduced to safe names; random identifiers, fresh request authorization, no-store/nosniff and explicit disposition protect downloads. Images preview inline; PDF downloads as attachments. Evidence is retained, never automatically pruned. Quota changes require reviewed configuration/code changes; monitor database/backup capacity.

## Financial policy

Service agreements supplement existing pricing where collector, contractual allocation and recurrence are missing; generated customer obligations remain existing collections. Monthly software 1,000 USD and consulting 700 EUR are independent obligations. Consulting 200 EUR ROISE + 500 EUR partner equals 700 EUR, never 900 EUR. Media budgets are not commissionable consulting. Each period snapshots terms and collector, so future changes cannot rewrite history.

Collector is explicitly ROISE or the named commercial partner, independently of employee accounts. Default allocation is proportional to net actual collections with checked integer/i128 rounding and contractual caps; explicit contractual policy recognizes the agreed split regardless of collection timing. Internal settlements are separate append-only transfers referencing the original period, never customer payments. Refunds use append-only positive reversals linked to original positive payments; originals remain immutable. Net customer balance and allocation reflect reversals. A refund after an internal transfer can create an opposite reconciliation obligation and must not erase the transfer. Currency changes require a new agreement; no implicit FX, proration, fiscal invoice or commercial backfill.

## Automation policy

Use a bounded in-process worker with the same shutdown lifecycle and durable SQLite occurrence identities. Organization business timezone is explicitly configurable (initial Europe/Bucharest); UTC instants retain six fractional digits. Daily/weekly/monthly schedules use local calendar dates; monthly anchors clamp to the month's final day and return to the original anchor in following months. Ambiguous local due times use the earlier occurrence, gaps move forward to the first valid local minute. No timestamp-based month arithmetic.

Each template/date and agreement/period generates once under an IMMEDIATE transaction and unique constraint. Activation begins prospectively; pause/resume skips paused periods, cancellation stops future generation, historical occurrences remain unchanged. Missed active runs reconcile in bounded batches. Catch-up over 62 days is refused for authorized reconciliation; no bulk retroactive billing action is implemented. Non-prorated monthly charges use an anchor-date billing policy with an explicit due-day offset. In-app reminders deduplicate by event/occurrence and recipient; no external messaging credentials are needed.

## Migration and deployment

Only new checksummed migrations; retain existing identities, grants, websites, tasks, financial records and immutable history. Extend recovery table inventory and financial verification alongside new models. No automatic downgrade; take a new supported backup after upgrade. Do not run production migration/deployment. Keep one custom image and fixed production volume. Final acceptance must distinguish executed passes, failures, blocked and unexecuted checks.

Team administration grants a dedicated global `staff.read_team` role to the leader; the role contains no brand or finance permission. Per-brand leader and employee roles remain client scoped. Existing explicit grants are reused and marked independently owned, so assignment removal cannot revoke an unrelated administrator grant. An employee has one active team assignment per brand. Removing a membership or brand assignment revokes only managed grants, retains history, and unassigns unfinished standalone tasks when no other task access remains. Technical request authorship and delivery history remain; an authorized leader/owner can finish review. Leader changes revoke managed old-leader brand assignments and retain independently owned grants. An immutable leadership history records previous/new leaders and actor. Query scope changes immediately; a retained read-team grant grants no access without actual leadership.

## Commercial allocation and corrections (implementation policy)

One consulting billing period creates one existing customer collection for the total service fee. Software and media expenditure remain independent; no advertising platform is contacted. The period references an immutable agreement version and an explicitly named commercial partner. Each customer payment retains its actual collector, defaulting to the period's configured collector only for compatible existing payment forms.

For proportional settlement, compute the ROISE allocation once from aggregate net collections using checked i128 half-up division: `net_collected * roise_contract_share / total_contract_fee`. The partner allocation is the exact remainder. Aggregate calculation avoids a cent being repeatedly rounded away across partial payments. Internal amount due to ROISE equals recognized ROISE allocation minus funds actually collected by ROISE. A negative value is a payable to the partner. Internal transfers are positive retained records with an explicit direction; the remaining internal balance subtracts net transfers to ROISE. Transfers never become customer payments.

For the explicitly selected contractual policy, recognize the full contractual allocation. Uncollected funds are attributed to the configured contractual collector solely for computing internal obligations; they remain clearly uncollected customer receivables. This can require advancing the beneficiary's agreed share before customer collection and is never the default.

Positive append-only payment reversals are bounded by the original payment, restore customer outstanding, and reverse the original collector's funds. Original payments and internal transfers stay immutable. A refund after internal settlement can create a payable in the opposite direction. Storage and recovery calculate the net ledger using an exact i128 aggregate, including long histories where gross collections exceed i64 while the current balance remains within its original contractual amount. Cross-ledger revision guards prevent payment/reversal collisions.

Period amounts cannot be edited through generic collection endpoints. Voiding requires an explicit audited commercial-period action, zero customer-payment and internal-transfer history; the period's unique identity remains consumed. Pausing/cancelling an agreement affects future generation only. Currency changes require a new agreement; future prices are immutable versions with explicit prospective effective dates. Financial due dates preserve the existing collection ledger's UTC date convention; operational recurring task due times use named business timezones. No implicit exchange rate, legal invoice, tax calculation, proration or historical backfill is introduced.

Legacy payment collector fields are left NULL rather than guessing who received historical money. Newly generated service periods require an explicit persisted collector. Existing generic collection forms may use the immutable period default for compatibility, while the service interface allows choosing the actual collecting party. A future agreement version does not change a prior period's default. No commercial period may edit or cancel its collection through generic ledger actions.

## Scoped tasks and automation authority

New operational role templates use distinct `tasks.read_team` and `tasks.read_development` capabilities rather than inheriting legacy full-client `tasks.view`. Legacy explicitly granted roles remain unchanged. Team reads bind actual current leadership and brand membership; development reads bind own assignment or an accessible technical request. Team reassignment is a separate server action limited to supervised assignments. Generic task creation limits new operational roles to their actual assignment scope; accepted technical requests use a narrowly authorized internal task-creation path so developers may assign another authorized developer without gaining general staff-task authority. Personally assigned general tasks use `tasks.update_own`; technical task edits remain fenced by the request workflow.

Active automation records retain their creating identity and have a separately transferable, authorized management identity. The worker rechecks that identity's active account and required current client capabilities before each transaction, using `job` audit attribution. Revocation pauses effective generation and alerts authorized managers; no automatic authority fallback hides revoked grants. Another authorized owner can explicitly transfer management. Automatic catch-up must remain bounded; a billing schedule more than 62 days behind requires an explicit owner reconciliation, rather than surprising the customer with unlimited historical obligations.

Personal notification preferences apply to future events only and must not delete history or hide pending review state. Workflow, task and financial recipients remain permission-scoped. Financial notifications need a period/agreement parent and current commercial/collection read authorization; a stale notification never preserves access after revocation. Organization timezone updates apply to new configuration, while existing schedule/version timezones remain recorded.

### Automation management and reconciliation

Automation remains attributed to its configured manager; reassignment is explicit and restricted to active users with the current brand capabilities needed by that generator. Manager pickers expose names only, not email/session data. A failed run exposes a fixed error code and retry time to authorized schedule readers. Historical task versions and billing terms remain available. A billing period may be voided only with an audited reason, current revision and zero customer-payment/settlement history; periods with money movement use retained reversals instead.

## Module and API map

| Concern | Backend authority | Frontend |
| --- | --- | --- |
| Daily dashboard / dossier | `operations/today.rs`, `overview.rs` | `TodayPage`, `BrandOperations` |
| Requests / linked development work | `operations/requests.rs`, `tasks.rs` | `RequestCreatePage`, `RequestDetailPage`, `RequestListPage`, `TaskQueuePage` |
| Private images / delivery versions | `operations/evidence.rs`, request events/deliveries/reviews | `EvidenceUpload`, protected request detail images and timeline and before/after comparison |
| Organization / brand assignments | `operations/team.rs`, existing scoped grants | `TeamPage`, team member and assignment controls |
| Commercial services / settlement | `operations/commercial.rs`, `allocation.rs`, existing `billing.rs` | `FinancePage`, `RefundForm`, `VoidPeriod` |
| Recurrence / due alerts | `operations/recurring.rs`, `schedule.rs`, `automation.rs`, existing worker | `RecurringPage`, automation controls/history |
| Inbox / preferences / zone | `operations/notifications.rs`, `preferences.rs` | `Notifications`, `SettingsPage` |
| Restored integrity | `operations/integrity.rs`, existing `recovery.rs` | Operator backup/restore workflows |

All API paths start at `/api/v1`. Global `today`, `tasks`, `requests`, `operations-people`, `teams`, `notifications`, `preferences` and `operations-settings` bind current identity and scope. Brand-bound `clients/{client}/requests`, `evidence/{id}`, `agreements`, `commercial-periods` and `recurring-tasks` bind their actual parents. Named action subroutes enforce the server lifecycle and expected revision; transport uses the existing authentication/Origin/CSRF guards. Deliveries, timeline, occurrences, versions, payments, reversals, settlements and team history use bounded pagination. Exact mutation payloads are defined beside their serde inputs and strict frontend parsers, rather than a second specification that can drift.

## Operating the platform

1. Create separate real owner/developer/employee identities through existing Users. Bootstrap creates the first administrator only. Assign the existing full administrator definition to the second owner with audited owner authority. Never seed example people into an existing installation.
2. Create an advertising team, choose its actual leader, add active members and assign brand responsibilities. The dedicated employee role has no finance. Legacy Viewer retains historical finance grants and is unsuitable as an employee default. Owners can explicitly grant financial capabilities separately.
3. Open Today or the task/request queue. Use brand, website and authorized employee filters when needed. An employee submits a website-specific or explicitly brand-wide request with optional private evidence. No URL fetching occurs.
4. An authorized developer accepts/rejects, assigns an eligible developer, starts work and submits notes/files. An independent authorized requester/leader/owner approves or gives a required revision reason. Earlier evidence, deliveries and decisions remain accessible. Cancellation/reopening are explicit audited transitions.
5. Under brand Finance, configure the service amount/currency, named partner, ROISE share, collection party and allocation policy. Generate only an eligible due period or let the worker do it. Period filters use service name/type, billing dates, currency, immutable contractual collector, actual net-payment collector, partner and the existing payment-status precedence. Payment history independently shows actual collectors. Record actual customer payments against the existing collection. Record internal transfers separately against the period. Use a linked payment reversal for refunds; never overwrite a settled payment or add the ROISE share as another customer charge.
6. Configure a recurring task with the real assignee, optional website/supervisor, named zone, frequency/interval, anchor and end/count limit. Generated tasks enter the existing task/planning ecosystem; a template is not a completed occurrence. Prospective versions and pause/resume preserve completed history.
7. Settings contains appearance, personal workflow/task/finance notification preferences and the separately authorized organization timezone. Changing the zone affects new configurations; saved schedule/price timezones remain historical facts. Notification links reauthorize their destinations.

## Troubleshooting and limits

| Situation | Safe action |
| --- | --- |
| Schedule reports missing authority/inactive manager | Restore only intended grants or explicitly transfer management to an eligible current user; do not bypass the check. |
| Schedule reports catch-up window exceeded | Pause/resume prospectively after authorized reconciliation of missed work/fees using the existing records. There is no surprise historical bulk billing. |
| Worker has not generated an eligible instance | Check that the application is serving, schedule state/date/zone, current manager and assignee access, displayed failure code/retry time, and next generation identity. Normal idle polling is 30 seconds. |
| Request waits for review after requester departure | An independent authorized current leader or owner can review. Reassign operational responsibilities without erasing the original actor. |
| Evidence fails to upload | Check the supported signature/type, 8 MiB file limit, request/user/installation quota and parent permission. Unbound stages expire after 24 hours; bound history does not. |
| Notification is absent | Check future-event preference and current resource permission. Durable alert markers prevent repeated jobs from spamming, including when no authorized recipient exists. |
| Financial result differs from agreement | Inspect original period terms, actual collectors, net payment/reversal history, selected allocation policy and internal transfers separately, by currency. |
| Write response is lost | Preserve/retry the exact original command and revision; review authoritative history before discarding. Archived resources permit an already committed receipt to reconcile, not new work. |
| Void is denied | Any payment or settlement history requires retained financial corrections instead. A void consumes the period identity permanently. |

No new secret or external notification provider is required. Default business zone is Europe/Bucharest and is owner configurable. Existing financial due dates and payment dates preserve UTC-calendar semantics. Default contractual billing is non-prorated. Currency changes require a new agreement. Historical imports, tax invoices, production deployment, live-provider credential verification and horizontal replicas on shared SQLite are outside the implemented operational actions.

## Additive migration inventory

| Migration | Added authority / retained connections |
| --- | --- |
| `000003_operations.sql` | Teams, memberships, managed brand grants, leadership history, requests, linked task guards, private evidence, immutable deliveries/reviews/events, deduplicated per-user notifications and business settings |
| `000004_commercial_finance.sql` | Named commercial partners, immutable agreement terms, unique periods pointing to existing collections, nullable legacy payment collectors, append-only payment reversals/transfers and command receipts |
| `000005_recurring_operations.sql` | Recurring templates/immutable versions/unique occurrences pointing to existing tasks, personal preferences, bounded automation failures and durable alert markers |
| `000006_dashboard_attention_indexes.sql` | Additive cross-brand active task/reminder ordering and narrow outstanding collection indexes; no data transformations |

Migrations retain original users/clients/websites/tasks/plans/reminders/financial IDs. Foreign keys, triggers and integrity verification protect same-brand parents, immutable money history and valid linked workflow state. Global attention indexes are built during the exclusive startup migration and scan their existing tables; plan the upgrade window and checkpoint accordingly. They run in disposable tests or an explicitly authorized upgrade; no production migration was performed by this implementation. Automatic downgrade is unsupported. Take a verified schema-6 checkpoint before future artifact changes; a pre-upgrade backup requires its compatible artifact and a separate empty-target recovery plan.

## Acceptance coverage map

This map identifies executable coverage, not a claim that unexecuted release gates passed. Run `make check`, real HTTP, native or exact-image browser, then container/recovery/capacity/Compose gates under the supported tooling. Native serving/cache tests share port 6379 and run serially.

| Master scenarios | Coverage |
| --- | --- |
| 1–5, 13–15, 31–32 | Backend own/team/development scoping, employee finance isolation, managed assignment revocation, current notification/evidence parent checks; actual browser employee/leader/request/assignment journeys and denied HTTP actions |
| 6–12, 35 | Request domain state matrix, rejection/reopen, concurrent acceptance/idempotency, multiple delivery/timeline pages; actual browser screenshot submission → delivery → revision → second delivery → independent approval |
| 16, 34 | Full browser existing-module navigation plus operations at 360/390/430/1440/1920, theme/preferences and overflow assertions; retained modules under grouped client navigation |
| 17–23 | Exact allocation tests and persisted commercial tests for both collectors, partial/mixed collections, transfers, reversals and separate USD maintenance; actual browser 700/200/500 EUR flow and 1,000 USD / 600 USD payment |
| 24–30 | Calendar/DST/month-end/leap tests, daily/weekly/monthly persisted generation, retry, pause, future versions, current worker authority; real worker browser task/period generation and duplicate checks |
| 33 | Existing schema/grants/domain regression fixtures, additive migration tests and supported backup/restore table/history verification |

Unit/integration tests reside in `backend/src/operations`, existing domain suites and frontend operation/parser/flow suites. `frontend/e2e/operations.spec.ts` exercises four real operational journeys; the existing browser files cover login, navigation, brands/sites, task/planning/reminder/history, legacy finance/pricing, providers, five locales, CSP and both themes. Runtime gates use only owned disposable containers/volumes, never customer storage.
