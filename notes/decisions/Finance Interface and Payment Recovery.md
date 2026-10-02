---
type: decision
status: implemented-pending-owner-review
created: 2026-10-02
tags:
  - billing
  - frontend
  - exact-money
  - authorization
---

# Finance Interface and Payment Recovery

Issue #20 consumes owner-merged #19 at 26f2454. Both branches were synchronized; main run 37038850280 passed. [UI policy](https://github.com/theroisey/else/issues/20#issuecomment-5957528481) was recorded before implementation. See [interface guide](../../docs/billing-interface.md) and [[Exact Collections and Payment History]].

Major-unit input uses explicit reviewed currency and exact text/BigInt conversion. No Number money, rounding, default currency, FX or grand total. Summaries/statuses stay backend authoritative, independent of table filters. Guard response/client/currency/revision/page contracts. Billing-only direct routes never probe unrelated client metadata; every action needs view plus its explicit key, never billing.manage.

One intended payment uses one UUID plus its original normalized payload and revision. Unknown outcomes freeze that command above page routes, with explicit identical replay and bounded history reconciliation. Retry conflict remains unknown; absence from checked history is not proof of noncommit. Only API confirmation or matching immutable history reports success. The modal prevents a new command and survives in-app Back. No financial drafts/references persist in browser storage; unloading or identity/grant/auth-tree changes loses private recovery and requires manual history reconciliation before any replacement.

Reset only the recovery controller on actor/grant context changes. Keying the whole application subtree by grants broke established planning/reminder behavior that preserves selected resource IDs while removing unauthorized titles; full regression tests caught this and the boundary now leaves those forms mounted. Suppress payment late success after context loss.

Payment references are masked by default and absent from rendered hidden text/labels/tooltips; per-payment reveal is explicit and resets on page/access change. Notes belong only to finance detail. No raw references/commands enter logs, URLs, audit/activity projection or screenshots. Cancellation retains the append-only ledger, closes remaining obligation and never implies refund. Currency and paid collection amount are immutable in the form and backend.

The real browser test commits through the API, aborts the first transport response, navigates Back and sends the identical command/revision. PostgreSQL proves one payment and one payment event. It also verifies separate USD/KWD/JPY, stale revisions, masked history, paid amount freeze, cancellation, archived denial and revoked access. Local PostgreSQL17 is disposable; exact-head CI must cover PG18/containers before readiness.

- [[Authorization and Client Scope]]
- [[Authenticated Application Shell]]
- [[CI and Publication]]
