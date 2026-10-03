# Meta daily Insights normalization

[#96](https://github.com/theroisey/else/issues/96) implements the concrete backend decoder under marketing parent #25. `internal/integrations/providers/metaads.Normalize` interprets complete already-collected account-level daily responses. It is a pure package: no HTTP route, credential access, provider traffic, persistence, audit or frontend success state is enabled.

## Official contract evidence

Verified on 2026-10-03 from Meta's own `facebook/facebook-python-business-sdk` repository through supported GitHub access. [Release 26.0.2](https://github.com/facebook/facebook-python-business-sdk/releases/tag/26.0.2), published 2026-09-21, resolves through its annotated tag to commit `efd8423a2e595ea8d4c04eb824ce113f2f1d68cd`:

- [apiconfig.py](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/apiconfig.py) specifies Graph `v26.0` and SDK `v26.0.2`.
- [AdAccount.get_insights](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/adaccount.py) defines GET `/insights`, `level`, `time_range` and `time_increment` parameters. The intended subset is daily account reporting without breakdowns, asynchronous jobs or attribution actions.
- [AdsInsights fields/types](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/adsinsights.py) defines `account_id`, `account_currency`, `spend`, `impressions`, `clicks`, `date_start` and `date_stop` as strings. These seven fields are the decoder's exact row allowlist.

This verifies the generated field/version contract. It does not establish minimum OAuth scopes, token ownership, callback/revocation policy, supported deployment account access, currency exponent/rounding or conversion attribution. Direct Meta authorization documentation is still excluded by the managed workspace's enforced network policy. Live transport/ingestion cannot be enabled before that policy is verified and recorded under #24/#25. No proxy bypass or unofficial documentation mirror was used.

## Trusted context and bounds

The eventual freshly authorized lifecycle/transport supplies immutable canonical client/connection UUIDs, canonical numeric Meta account ID, account currency, explicit IANA reporting timezone and inclusive account-local dates. Response account/currency must match that expectation. Expectation validation is input integrity, not proof of authorization or ownership. Returned reports carry client/connection binding, currency/timezone/period and pinned Graph version; account ID, raw responses and navigation values are omitted.

An inclusive period contains at most 31 calendar days, across DST without UTC-day substitution. Accept one to four ordered pages, at most 64 KiB per page and 31 unique daily rows in total. Require explicit arrays, the exact row fields and string values; reject null/missing fields, unknown/case-aliased/duplicate decoded keys, trailing JSON, malformed UTF-8, invalid dates and any date outside the requested period. Each row's start/stop must be the same day. Identical dates are rejected rather than summed across or within pages.

Each nonfinal page requires nonempty rows, a bounded printable nonempty `after` cursor, and a `next` observation. Cursors cannot cycle; a final page cannot still advertise `next`. Navigation strings are bounded and discarded without following or logging them. Supplying an incomplete or extra page fails the entire report, with the fixed error `Meta daily Insights unavailable` and no partial result. Empty terminal data is accepted as an explicit empty observation; missing days are never filled with zeroes.

## Exact metrics

Spend is an exact nonnegative provider-reported decimal string: at most 18 integral and six fractional digits. Counts are canonical nonnegative decimal strings with at most 18 digits. These are conservative local ingestion bounds, not a claim about provider maxima. Unsupported values fail; there is no float, exponent notation, sign, grouping, silent truncation or currency/minor-unit conversion. Canonical spend removes insignificant trailing fractional zeroes. Totals use exact rational/integer arithmetic, including values beyond JavaScript's safe integer range.

CTR percent = clicks / impressions × 100; CPC decimal = spend / clicks; CPM decimal = spend / impressions × 1000. Derived values retain spend's provider units and currency context, with six fractional digits rounded half up. A zero denominator produces JSON null. Total ratios use summed spend/counts, never an average of daily ratios. Clicks need not be unique and CTR is not capped at 100%. Attribution is explicitly unavailable: reach, conversion, CPA and ROAS are not manufactured from this subset.

## Verification and remaining integration

Clearly synthetic tests cover complete paginated/empty/zero reports, weighted totals, six-digit rounding ties, large exact values, calendar/DST limits, account/currency isolation, missing/duplicate dates, cycles/incomplete pages, size/type/duplicate-field boundaries and navigation/account-data redaction. Fuzzing requires every failure to return the same fixed error and an entirely empty report. All five exact-head CI gates remain required for review.

Before exposing this report, #24/#25 must add verified authorization/credential/HTTP policy, freshly fenced account context and sync/retention/audit storage; the separate frontend must consume authorized measured reports with honest age/error/unavailable states. This package does not mark a connection or sync successful and does not close either parent.
