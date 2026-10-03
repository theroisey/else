# Read-only Release Center contract

Parent [#29](https://github.com/theroisey/else/issues/29) identifies the running revision without introducing deployment commands. Backend [#92](https://github.com/theroisey/else/issues/92) supplies immutable build metadata and a protected read endpoint. Separately reviewed [frontend #93](release-interface.md) adds the read-only Release Center and permission-aware revision indicator.

## Current runtime and unavailable evidence

`GET /api/v1/releases` requires a current cookie session and fresh global `releases.view`. An authenticated actor lacking that grant receives 403; expired/revoked/disabled sessions receive 401. Scope, actor or evidence sources cannot be supplied through query/body. Only GET at the exact path is supported; extra paths/queries fail 400 and other methods fail 405. Responses use the existing data/error envelopes, request correlation and `Cache-Control: no-store`. Reads create no audits or database rows.

`data.runtime` contains `status`, `version`, `commit_sha`, and `built_at`. Available metadata identifies this API binary: version `sha-` plus its full lowercase 40-hex commit and canonical UTC RFC3339 build time at second precision. All three values must form a valid complete compile-time stamp. Plain developer builds and malformed/partial stamps return `status: unavailable` with three null fields. Runtime environment variables cannot replace embedded values; arbitrary raw inputs are never projected.

`data.latest_release`, `data.image_provenance` and `data.deployment` each contain only `status: unavailable`. No authenticated authoritative release/registry/deployment observation source is implemented. A commit embedded in a running binary does not establish a signed artifact digest, latest approved release, rollout success or production status. The API makes no outbound calls and never changes its binaries. `releases.manage` grants no deployment route.

## Building and CI stamping

From `backend`, the strict helper accepts an output path and either three empty metadata arguments or a coherent complete stamp:

```sh
sh scripts/build-api.sh /tmp/else-api '' '' ''
sh scripts/build-api.sh /tmp/else-api "sha-$TESTED_REVISION" "$TESTED_REVISION" "$UTC_BUILD_TIME"
```

Obtain inputs from the reviewed checkout/build process, never user requests or secrets. Empty inputs leave metadata unavailable. Malformed, partial, zero/uppercase revisions, mismatched version and invalid/noncanonical timestamps fail before Go invocation with a fixed diagnostic. Arguments are validated values, not command fragments. Go linker inputs are immutable; build VCS inference is disabled so it cannot misrepresent an untracked local checkout.

Docker's build stage accepts `BUILD_VERSION`, `BUILD_REVISION` and `BUILD_TIME`; ordinary unstamped builds remain usable with honest unavailable metadata. Isolated Container CI derives the tested full revision from its committed checkout, generates one UTC build timestamp and passes all values through the Compose CI overlay. Its actual non-root production API must report that exact stamp through a real protected cookie session. Synthetic privileged/viewer sessions prove 200/403/401 and strict read-only grammar. Image labels alone do not satisfy this check.

Main-only publication continues to promote the same tested frontend/API images through the existing revision/tag safeguards. A SHA version is a build identifier; an optional registry version alias is not inferred as an approved release. PR publication remains skipped. No operator image is added to publication and no production rollout is performed.

## Verification and rollout

Unit/race tests cover coherent validation, unavailable redaction and runtime override refusal; shell-helper negative tests prove unsafe inputs never invoke Go. Disposable PostgreSQL tests cover fresh grants, another session's denial, role revocation/regrant, disabled users, strict methods/queries, authorization failure and no read audit. A real compiled API test verifies exact stamp and runtime override refusal with authenticated database access. All five exact-head gates remain required.

No new migration, permission seed or storage grant is needed. Existing identity/authorization schema and reviewed runtime grants must be applied before API rollout. Frontend rendering must handle absent metadata and unavailable independent evidence separately; deployment authorization and external observation integrations require later explicit scope.
