# Exact collections and payment API

Issue [#19](https://github.com/theroisey/else/issues/19). The [financial and API policy](https://github.com/theroisey/else/issues/19#issuecomment-5956500604) was recorded before implementation. Owner-merged audit compatibility #60 and permission compatibility #61 prepare the existing consumers. PR #61 merged at `2693164`; both branches were synchronized and main [run 37032475739](https://github.com/theroisey/else/actions/runs/37032475739) passed all gates/publication. PR #62 was owner-merged at `26f2454` and main [run 37038850280](https://github.com/theroisey/else/actions/runs/37038850280) passed. Issue #20 consumes this API in the [finance workspace](billing-interface.md).

## Exact money and currency

All monetary values and finance revisions serialize as canonical decimal **strings**. Positive collection/payment amounts range from `"1"` to `"9223372036854775807"`; paid and outstanding balances may be `"0"`. Reject floats, JSON numbers, signs, whitespace, fractions, exponents, leading zeroes and overflow. PostgreSQL bigint stores individual amounts; numeric computes currency-separated aggregate totals, which may exceed int64. Consumers must preserve strings or use exact integer/decimal arithmetic.

| Currency | Minor-unit exponent | Example |
| --- | --- | --- |
| USD, EUR, GBP, TRY | 2 | `"123"` means 1.23 major units |
| JPY | 0 | `"123"` means 123 major units |
| KWD | 3 | `"123"` means 0.123 major units |

The six currencies are explicit reviewed definitions, with no default, conversion, exchange rate, rounding, tax/discount computation or major-unit input. New currency definitions require a reviewed migration. Collection currency/exponent are immutable; amount may change only before its first payment. Later metadata edits never reinterpret historical payments or change a paid obligation's amount.

## Permissions and lifecycle

Every read requires current effective `billing.view` for a real client. Writes also require `billing.create` for creation, `billing.update` for edits/payments, or `billing.delete` for confirmed cancellation. Global assignments satisfy client keys with explicit valid client context; client assignments cover only the exact client. Role names, authorship, `billing.manage`, and other write keys imply none of these capabilities. Migration 12 adds explicit links only to Initial Administrator, bringing the runtime catalog to 33. Finance/custom roles need explicit grants.

Archived clients retain authorized collection/payment reads and committed-command reconciliation, but reject new writes. Revoked/disabled actors cannot read or replay history. Cancellation permanently closes an unsettled collection, leaves all original amounts/payments/references intact, and sets collectible outstanding to zero. Fully paid collections cannot cancel. Cancelled records cannot edit, reopen or receive a new payment; there is no hard deletion.

Status derives on each database statement, with precedence **cancelled > paid > overdue > partially_paid > pending**. A positive remaining balance is overdue when due_date is strictly before that statement's UTC calendar date. Today is not overdue. A partially paid overdue collection remains overdue; paid/cancelled records never become overdue. This uses calendar dates without timezone scheduling or background status writes.

## Routes and JSON

All routes are under `/api/v1/clients/:clientID/billing`:

| Method/path | Result |
| --- | --- |
| GET `/` | Paginated collections; filters below |
| POST `/` | Create collection, 201 |
| GET `/:collectionID` | Current collection detail |
| PUT `/:collectionID` | Replace editable profile with expected_revision |
| GET `/:collectionID/payments` | Paginated retained payment records |
| POST `/:collectionID/payments` | Record payment, 201; identical committed replay, 200 |
| POST `/:collectionID/cancel` | Confirmed permanent cancellation |
| GET `/summary` | Exact totals separated by currency/exponent |
| GET `/currencies` | Six available code/exponent definitions |

Use paths without a trailing slash. Nonpaginated replies are `{ "data": ... }`; list replies are `{ "data": [...], "page": { "limit": 25, "next_cursor": null } }`. Lists use ascending UUID keysets, default limit 25, maximum 100, and one lookahead row. Payment UUID order is not payment-date order. UUID cursors are boundaries, not cross-request snapshots; changing filters starts a new first page. Newly committed records before an existing boundary appear on refresh.

Collection query keys: limit, cursor, status (`all` default, pending, partially_paid, paid, overdue, cancelled), currency (one reviewed code), search (trimmed, literal case-insensitive description match, maximum 100 characters). Payment queries accept only limit/cursor. Unknown, duplicate, empty or malformed parameters fail. Summary/currency/detail/mutation routes accept no query.

Create profile, with no client/creator/status/revision supplied by the caller:

```json
{
  "description": "Synthetic collection example",
  "internal_note": "Clearly synthetic internal note",
  "amount_minor": "10000",
  "currency": "USD",
  "due_date": "2026-10-31"
}
```

Description is required, trimmed, up to 2000 characters; internal_note defaults to empty and permits up to 8000. Both allow line feeds but reject other control characters. due_date is null/omitted or a real `YYYY-MM-DD` date in years 0001–9999. PUT supplies the same full profile plus string `expected_revision`; omitted due_date clears it, and omitted note clears it. Currency must match the original, and a changed amount conflicts after any payment. Metadata may still edit on fully settled active collections.

Collection reads return id, client_id, created_by, profile fields, currency_exponent, exact paid_minor/outstanding_minor, status, string revision, cancelled_at and server created_at/updated_at. They contain no expanded actor directory. Mutation replies contain id, string revision, nullable payment_id and replayed.

Payment command:

```json
{
  "expected_revision": "1",
  "command_id": "b1000000-0000-4000-8000-000000000001",
  "amount_minor": "2500",
  "currency": "USD",
  "paid_on": "2026-10-02",
  "method": "bank_transfer",
  "reference": "Clearly synthetic reference",
  "note": "Clearly synthetic note"
}
```

Caller generates a new nonzero command UUID for each intended payment. Currency must match, and positive amount cannot exceed the remaining balance. paid_on is required, a real calendar date no later than the statement's UTC date; retrospective dates may predate collection creation. Methods: bank_transfer, cash, card, other. Reference defaults empty, max 200 characters without controls; note defaults empty, max 2000 with line feeds permitted. These are authorized financial detail, never audit/activity/log input; do not collect credentials or full card/account data. Payment reads retain these fields plus server id, client/collection IDs, recorded_by, string collection_revision and recorded_at.

Identical normalized command retries by the original actor, with the original expected_revision and payload, return the committed payment ID and current collection revision without changing ledger/audit. This reconciliation remains available after cancellation/client archival under current view+update permissions. Reusing a command for another actor, amount, currency, revision, date, method, reference or note conflicts. Reconcile an unknown commit outcome with retained history/original command; never blindly create a new payment command. Refunds/reversals/negative payments are unsupported and rejected; future corrections require a separate append-only policy.

Cancel body is `{ "expected_revision": "2", "confirm": true }`; confirmation is required. DELETE/PATCH/HEAD/OPTIONS are not mutation alternatives. Unsupported refund/reverse routes return a safe error.

## Currency-separated summaries

`data` is an array, one group per represented currency/exponent, ordered by currency; an empty client returns `[]`. Every monetary property is an exact decimal string. amount_minor, paid_minor and outstanding_minor include only noncancelled collections. overdue_minor sums their overdue remaining balances. cancelled_amount_minor and cancelled_paid_minor separately retain cancelled historical totals. No cross-currency grand total, fabricated revenue or implied refund is produced.

## Transaction and storage boundaries

Each writer acquires the shared authorization/lifecycle transaction advisory lock, then the collection row lock, and rechecks current grants/client/archive/revision/balance. Stale new commands conflict. Typed monetary audit and business mutation commit together; audit failure rolls back payment, balance, revision and lifecycle changes. Committed replay takes the same checks/lock but exits through a read-only rollback with no event. Failed commits require reconciliation.

Runtime receives EXECUTE only on six guarded finance functions and no SELECT/INSERT/UPDATE/DELETE/TRUNCATE on finance tables or private projectors. Fixed pg_catalog definer paths and fully qualified relations prevent search-path substitution. Payment UPDATE/DELETE/TRUNCATE and collection deletion/truncation are always trigger-denied. Financial identity/currency are immutable, and paid amounts freeze the collection total. Composite foreign keys enforce collection/client/currency references; actor references survive disablement. Deferred, private security-definer checks enforce cached paid_minor exactly equals the append-only ledger at commit without granting runtime table access.

Events billing.created/updated/payment_recorded/cancelled store exists/revision plus billing_status, currency, amount_minor and paid_minor, all through typed allowlists and resource binding. Description, internal note, payment date/method/reference/note/command payload never enter audit. Backend action/filter validation recognizes the new billing events. The audit reader still projects only its original eight safe markers; monetary storage adds no audit detail field. Activity stays its separately narrower domain projection.

## Migration and verification

Apply migration 000012 with the separate migration owner and reapply reviewed runtime grants before starting this API. Plan normal migration lock/statement budgets; no production migration is performed here. Empty down restores previous audit allowlists/actions/reader filters, removes only finance schema/default new permission links and preserves old business/audit history. Down refuses any finance collection/payment/audit or custom/revoked new-permission history. Recreated functions need grant reapplication; populated systems require a forward change.

Focused coverage includes exact int64/above-JavaScript values, aggregates above int64, all six scales, partial/full/overdue/cancelled state, 16 grant combinations, strict HTTP/auth/CSRF/query/body handling, pagination, ledger/reference/storage denial, replay/conflicting command reuse, payment/edit/cancel races, queued revoke/disable/archive checks, mandatory audit rollback, unchanged audit-read projection and empty/populated migration history. Full Go race/PostgreSQL regressions, vet and static builds accompany this API. Local PostgreSQL 17.11 is disposable; final-head CI supplies PostgreSQL 18, 231 frontend tests, all ten existing real-API browser flows and container gates before owner review. No frontend source/dependency change, agent merge or deployment is introduced.
