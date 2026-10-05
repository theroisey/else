# Release Center interface

Frontend [#93](https://github.com/theroisey/else/issues/93), refined by [#132](https://github.com/theroisey/else/issues/132), provides the read-only interface under parent #29 using the [release evidence contract](releases.md). `/app/releases` and navigation require current global `releases.view`; client-only grants do not authorize release metadata.

The page identifies the running API build with its full SHA version, commit and exact UTC build timestamp. A restrained shell link shows the short API revision on wider screens; narrow screens keep the Release Center in navigation. Missing valid embedded metadata is explicitly unavailable. Independent latest-artifact and image-provenance panels render validated GHCR/GitHub observations when available, including immutable identifiers, content digests, source and optional publication completion. Metadata matching has its own label; digest-matching attestation presence explicitly says the application has not verified its signature. Deployment remains unavailable because no authoritative rollout source exists. Build identity and publication alone never certify a production rollout. No update, import or deployment controls exist. All new copy is translated into English, Turkish, Romanian, German and French.

## Reads and recovery

Use only the same-origin protected GET `/api/v1/releases`, with no query, caller-selected source, browser persistence or browser-to-provider request. Strict bounded validation accepts coherent binary and artifact identifiers, SHA-256 digests, canonical UTC timestamps and classified independent observations; unknown fields/statuses and malformed metadata fail safely. Safe classified upstream failures keep the running binary stamp readable. Server messages and arbitrary response text are never displayed.

Page and shell share one identity/grant-scoped query. Reads use existing current-context checks, no-store transport and cancellation; changing identity/grants cannot reuse the old report. On 401/403 the existing session refresh removes revoked or expired access. Loading and failures hide prior metadata; failure offers explicit refresh, with no automatic retry or mutation. Session expiry returns to real sign-in. Manual refresh uses the fixed revalidation header through the same protected transport, supports keyboard operation and disables during loading.

## Verification

Unit tests cover exact validation, available/partial/unavailable states, safe manual recovery, deduplicated protected reads, client-only denial, revoked grants, session expiry and late responses from an old identity. The full frontend suite, lint/typecheck and production build remain required.

The real-API browser flow provisions a clearly synthetic global release reader in disposable PostgreSQL, logs in through the real cookie API, checks the stamped checkout revision/build time, confirms reads add no audits, exercises keyboard refresh and desktop/mobile widths, and revokes the grant to verify API/UI denial without cached metadata. The browser runner stamps its API with the same strict helper and passes expected inputs to Playwright. Screenshots are labelled synthetic and contain no credentials. All six CI gates precede exact tested-image publication. No production execution, rollout or deployment is performed. See the [current refinement verification](refinement-verification.md) and [localized available-evidence capture](screenshots/release-evidence-dark.png).

## Original interface captures (#93)

Local verification passed 448 frontend tests, lint/typecheck/build, and the actual stamped API/disposable PostgreSQL 18.3 browser flow using installed Chromium on isolated alternate ports. The existing developer listener remained untouched. CI repeats the complete browser suite with its pinned Chromium. The local screenshots below show synthetic data and a real tested API revision; their build timestamp is an observation, not deployment evidence.

![Synthetic desktop Release Center](screenshots/releases-desktop.png)

![Synthetic mobile Release Center](screenshots/releases-mobile.png)
