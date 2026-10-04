# GA4 bounded aggregate adapter

Implements collection under existing [#26](https://github.com/theroisey/else/issues/26), using the [service-account exchange](ga4-service-account.md), [trusted HTTPS transport](provider-https.md) and strict [integer report interpreter](ga4-integer-reports.md). `ga4.NewAdapter` constructs fixed Google origins and shares the worker's two-request admission gate. `Fetch` collects all five tables atomically, with a 120-second operation budget and no retries, background goroutines, cache, database writes or state transitions. Application setup, durable jobs, client authorization/generation fences, retention and measured API/UI publication must surround this adapter; they are not enabled by calling its constructor.

## Verified contract and authorization

Google's immutable `googleapis/googleapis` revision [ed6832a8b8254885e1ddc352bb1dc30b7f26f950](https://github.com/googleapis/googleapis/tree/ed6832a8b8254885e1ddc352bb1dc30b7f26f950/google/analytics) establishes:

- [Admin service](https://github.com/googleapis/googleapis/blob/ed6832a8b8254885e1ddc352bb1dc30b7f26f950/google/analytics/admin/v1beta/analytics_admin.proto): `analyticsadmin.googleapis.com`, `analytics.readonly`, GET `/v1beta/properties/{id}`.
- [Property resource](https://github.com/googleapis/googleapis/blob/ed6832a8b8254885e1ddc352bb1dc30b7f26f950/google/analytics/admin/v1beta/resources.proto): exact canonical name, IANA reporting timezone/day boundaries, timezone changes affecting future data, and output-only deletion timestamp.
- [Data service](https://github.com/googleapis/googleapis/blob/ed6832a8b8254885e1ddc352bb1dc30b7f26f950/google/analytics/data/v1beta/analytics_data_api.proto): fixed-origin `runReport`, exact-request `checkCompatibility`, property-local inclusive ranges, explicit offset/limit/order and total row count. Compatibility responses include catalog columns, not only requested names.
- [Data types](https://github.com/googleapis/googleapis/blob/ed6832a8b8254885e1ddc352bb1dc30b7f26f950/google/analytics/data/v1beta/data.proto): current metric description/type, custom/expression/blocked metadata and report quality flags. Blocked metrics may return zeros; those are never treated as measured activity.

The backend exchanges a provisioned service-account key for the sole read-only Analytics scope, reads the exact property and rejects missing/deleted/wrong properties or invalid/local timezones. It checks current compatible, noncustom, unblocked metadata for each exact report combination, and rechecks property access/timezone after all tables. A failure discards the complete workspace. Possession of a key and API access do not establish legal ownership or authorize assignment to an application client.

## Templates and metric semantics

Only these compiled templates can be collected. Callers cannot supply arbitrary dimensions, filters, metrics, expressions, URLs or provider endpoint overrides.

| Table | Dimensions | Period |
| --- | --- | --- |
| Summary | None | One complete property-local period |
| Daily | `date` | Same period, dated observations |
| Acquisition | `date`, `sessionDefaultChannelGroup` | Same period, session channel grouping |
| Devices | `date`, `deviceCategory` | Same period |
| Landing | `landingPage` | Same period, aggregate paths without query strings |

Each requests `activeUsers`, `sessions`, `screenPageViews`, `keyEvents`. Exact current provider display names and descriptions are fetched from selected metric metadata and returned as text definitions; fixture descriptions are explicitly synthetic, not a verified live metric catalog. Missing or changed descriptions/types across the batch make it unavailable. Counts require `TYPE_INTEGER`; `keyEvents` supports integer or floating attribution as freshly declared by the provider. No conversion rate, denominator, `eventCount` substitution or financial metric is inferred. These observations depend on the property's own event/key-event configuration and provider definitions.

Summary is an independent dimensionless request. Do not sum daily/dimension active-user counts to manufacture period users. Do not reconcile disaggregated tables by invented arithmetic; the API does not promise a cross-request snapshot. Page totals/date bounds/order are checked, but a stable row count does not prove data remained frozen during pagination.

Counts remain exact strings up to 18 digits. Floating attribution values become canonical nonnegative decimal strings with at most 18 whole and 18 fractional digits, supporting bounded scientific notation with exponent −18 through +18. Conversion uses decimal-string manipulation, never binary floating arithmetic or rounding. This preserves the supplied numeric representation's value; it does not claim the provider's internal floating value has infinite precision. Unsupported values fail atomically.

## Bounds, privacy and failure behavior

One inclusive property-local date range spans at most 31 days, using explicit ISO dates since 2000. Daily dates must fall inside that range. The application's Europe/Istanbul display convention does not shift property report dates. Every table has a fixed 200-row request limit, at most five complete pages/1,000 rows and 64 KiB per page. Explicit ascending ALPHANUMERIC ordering over all dimensions, contiguous offsets, stable row count, exact headers/types/widths, unique ascending tuples and full completion are required. Larger tables or pages are unavailable, never presented as a complete truncated report.

The compatibility projection includes only names, compatibility, custom flags and metric type/expression/blocked reasons/current definitions, with a separate 256 KiB cap and at most 2,048 entries per catalog. Only the requested columns survive. Property reads and token responses remain 64 KiB. Public workspace results contain client/connection IDs, dates/timezone, column names, observations and selected definitions; they contain no property/account identifier, credential, raw response, unused catalog or provider diagnostic.

No pageLocation/query strings, user/customer/event identifiers, custom dimensions or revenue data are requested. Landing paths must be relative `/...` or `(not set)` and cannot contain query/fragment/email/backslash data or network-path URLs. Aggregate site paths can still contain sensitive content; provisioning must use a property whose collection excludes personal data. This structural check cannot prove arbitrary site paths are anonymous. Render provider text as ordinary escaped text.

Any blocked, sampled, thresholded, restricted, data-loss, truncated, malformed, oversized, incomplete, canceled, expired-token or changed-schema outcome returns the same fixed unavailable error and zero workspace. Empty observations remain an empty array; measured zero rows are preserved. No rate-limit/status/body diagnostic is disclosed and no automatic business retry occurs. A subsequent durable scheduler must supply bounded quota-aware retries and expose honest freshness/failure states.

## Evidence and remaining acceptance

Synthetic contract tests verify complete five-table requests and exact metric values, current definitions, distinct summary, 0/200/201/999/1,000-row pagination, late failures/cancellation at every request, wrong/deleted/changed property, expiry, metadata restrictions, schema/quality/period/privacy failures, and private-result rejection. Separate transport tests exercise real isolated TLS and exact/chunked metadata caps. No live provider/property, deployed egress, permission provisioning, dashboard route, encrypted setup, durable scheduling or ingestion is claimed. Those remain open in #26; no new issue is needed and no additional application image is introduced.
