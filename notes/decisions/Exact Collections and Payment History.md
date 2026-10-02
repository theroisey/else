---
type: decision
status: owner-merged
created: 2026-10-02
tags:
  - billing
  - exact-money
  - authorization
  - audit
  - database
---

# Exact Collections and Payment History

Issue #19's [financial policy](https://github.com/theroisey/else/issues/19#issuecomment-5956500604) preceded implementation, after owner-merged audit/permission consumer prerequisites #60/#61. Both branches were synchronized at 2693164; main run 37032475739 passed all gates/publication. PR #62 was owner-merged at 26f2454; both development branches synchronized and main run 37038850280 passed. The [API contract](../../docs/billing.md) is the frontend seam; #20 adds [[Finance Interface and Payment Recovery]].

Use positive int64 minor units with immutable reviewed currency/exponent, JSON decimal strings, and numeric aggregates that may exceed int64. Initial currency set is USD/EUR/GBP/TRY exponent2, JPY0 and KWD3. No binary float, rounding, conversion or default currency. Only explicit unpaid collection edits may change its amount; the first payment freezes it. Summaries never combine currencies or infer revenue.

Payment history is append-only. Reject overpayment and unsupported refund/reversal/negative commands. A caller command UUID and original actor/revision/normalized payload identify one payment: exact retry reconciles its committed ID/current revision without another event, even after archival/cancellation under current view+update grants. Mismatch or stale new command conflicts. Unknown commit outcomes require reconciliation rather than a new command.

Derived status precedence is cancelled > paid > overdue > partially_paid > pending. UTC calendar due dates become overdue strictly before today, without background mutation. Confirmed cancellation closes only an unsettled obligation, retains all amounts/payments/references and cannot reopen. Cancelled historical amount/paid totals are separate from active collectible totals. Retrospective paid_on dates are allowed; future dates are not.

Every read requires exact-client billing.view; mutations add create/update/delete. Legacy billing.manage, authorship and role names confer none of the new capabilities. Only Initial Administrator receives new seed links. Runtime has guarded function EXECUTE with no finance table access. Writers share the existing authorization/lifecycle lock and row lock, rechecking after waits. Deferred private definer checks enforce exact ledger/cache agreement at commit. Storage triggers preserve payment/currency/actor references and prohibit history removal.

Business and typed safe financial audit commit atomically. Monetary storage markers never expand the existing eight-key audit read projection; descriptions, notes, payment references and command payloads stay outside audit/activity/logs. Migration12 restores old audit/filter contracts on empty down, refuses populated finance/custom permission history, and requires runtime grant reapplication after recreation. Operators decide production migration windows; agents never deploy or merge.

- [[Authorization and Client Scope]]
- [[Audit Infrastructure]]
- [[Audit Read Scope and Safe Inspection]]
- [[PostgreSQL Foundation]]
- [[CI and Publication]]
