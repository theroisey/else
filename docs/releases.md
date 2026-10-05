# Read-only Release Center evidence

[#132](https://github.com/theroisey/else/issues/132) extends the immutable binary stamp from #92 and the interface from #93. The authoritative distribution is the single application image in GHCR, published by `.github/workflows/ci.yml`. A GitHub Release object is not required and no semantic version is inferred from a SHA tag.

## Server configuration

Set these **runtime** environment variables in `.env` or the hosting secret manager:

```dotenv
GITHUB_TOKEN=
GITHUB_REPOSITORY=theroisey/else
```

Use a real token only in the runtime secret configuration. `GITHUB_REPOSITORY` is strictly validated as `owner/repository`, normalized to lowercase, and cannot include URLs, refs, query strings or additional path segments. Missing or invalid configuration produces a safe `unavailable` observation; it does not stop the application.

`GITHUB_TOKEN` is entirely server-only. Never use `VITE_*`, Docker build arguments, committed environment files, image layers, database rows or browser persistence for this credential. Application logs/errors never include upstream bodies, URLs, headers, transport error strings or token values. PostgreSQL and the synchronization worker do not inherit this credential. Setting this variable **does not log the host's Docker client into GHCR**.

A fine-grained PAT (`github_pat_…`) needs access to this repository with **Contents: read**, **Actions: read** (publication completion), and **Attestations: read** (attestation lookup); Metadata read is implicit. Public GHCR images are read anonymously through a short-lived registry pull token. GitHub Packages currently supports **classic PATs only** for authenticated private-package access: use **read:packages**, repository/package access and any organization SSO authorization. For private repository API access, a classic PAT also requires the applicable `repo` scope. No write, delete or administrative permission is required by the application. A fine-grained PAT cannot substitute for a private GHCR credential; the UI reports this precisely.

## What each observation proves

| Section | Evidence | Limits |
| --- | --- | --- |
| Running API build | Immutable linker stamp: coherent `sha-<40 lowercase hex>`, commit and UTC build time | Identifies this binary; cannot prove its container digest or production location |
| Latest release | GHCR `latest` discovery, hashed manifest/configuration, matching immutable `sha-<commit>` manifest, OCI source/revision/version/creation time, GitHub commit in the configured repository | A published artifact, not an approved semantic release or production rollout |
| Image provenance | Independently matches the running binary's commit/version/build time to its immutable GHCR image, validates SHA-256 manifest/configuration content, OCI source and GitHub commit | Registry metadata matching; the API cannot inspect its enclosing container/host digest |
| Signed attestation | Digest-specific GitHub attestation lookup with matching in-toto subject and SLSA predicate | `present` means retrieved and subject-matched; the application does **not** perform cryptographic signature/trust verification |
| Deployment | Explicit `deployment_source_not_connected` | No authoritative production deployment source exists; no fake GitHub Deployment records are created |

`published_at` comes only from the successful **Publish tested main application image** job of a successful main `push`/`workflow_dispatch` CI run with the matching commit. If that independent API evidence is absent, publication time is null; OCI build time is never substituted for publication time. Workflow lookup is bounded to 10 matching successful runs and 100 jobs per eligible run. Older images lacking the new OCI source/version labels honestly report incomplete evidence. Optional `vMAJOR.MINOR.PATCH` aliases remain immutable publication aliases of the same SHA artifact; the API uses the stronger SHA identity and does not manufacture a semantic version.

## Protected API and refresh

`GET /api/v1/releases` remains session-protected with fresh global `releases.view` and `Cache-Control: no-store`, including errors. Expired/revoked/disabled sessions receive 401, unauthorized actors receive 403. Only the exact GET path without query parameters is allowed. The endpoint has no update/deploy/import capability and reads create no audit/database rows.

A manual refresh sends the fixed `X-Release-Refresh: revalidate` header. It selects no repository, ref, provider, registry or arbitrary URL. Invalid header values fail 400. The service has a 60-second sanitized in-memory cache, coalesces concurrent readers, and allows manual revalidation after a 10-second minimum interval. Rate-limited primary sources receive a five-minute backoff, including manual refresh. Browser responses are never HTTP-cached; identity/grant isolation remains independent of this repository-only server cache. Horizontal replicas have independent bounded caches.

Outbound requests have a four-second total collection budget inside the five-second API request budget, three-second per-request timeout, context cancellation, fixed TLS-verified hosts, GitHub version/Accept headers and a clear User-Agent. Responses are capped at 2 MiB; image configuration also must match its declared size/digest. Redirects are refused except one GHCR blob hop to the exact HTTPS `pkg-containers.githubusercontent.com` host, with a fresh credential-free request and subsequent content hash verification. Response links/authentication challenges never choose a new evidence source. Failures yield fixed safe codes, preserving readable runtime identity and independent evidence sections.

## Attesting the tested image

CI still requires all six gates and promotes its saved tested image without rebuilding. The publication script now compares the actual local content ID of an existing immutable SHA image with the tested archive; matching revision text alone cannot authorize an untested image. Existing SHA/version aliases are never overwritten. `latest` advances only while this revision remains main's head.

The pinned current official `actions/attest` v4 action signs the **promoted digest** and records it in GitHub/GHCR. Only the publication job gains `id-token: write` and `attestations: write`, alongside its existing package write. Storage records are disabled, avoiding unnecessary artifact-metadata permissions. GitHub CLI then verifies the digest, repository, signer workflow, main source ref and exact source SHA. This attestation identifies the same workflow that built, tested and promoted the image; it does not claim an independently isolated SLSA Level 3 builder. Verification failures fail publication verification. No second production build or second application image is introduced.

The application reports attestation presence independently of this CI verification; it never asserts it has independently verified a signature. Operators can use GitHub CLI `gh attestation verify` against the immutable digest using the same repository/workflow/source policy. No Docker socket or CLI credential store is mounted into the application.

## Verification

Deterministic injected-transport tests cover configuration, missing/unauthorized/forbidden/not-found/malformed/oversized/rate-limited evidence, timeout/cancellation, content/revision/source/build mismatches, cache expiry/manual refresh/coalescing/backoff, partial attestation states, fixed hosts and credential redaction. Real PostgreSQL tests retain session/fresh-grant isolation, strict grammar, no-store and read non-mutation, and prove denied callers cannot trigger evidence requests. Browser/frontend tests cover independent available/unavailable/error states, fixed-header refresh, late identity responses and safe revocation/expiry recovery. CI checks the stamped production binary in the single container with unconfigured remote evidence; tests never depend on GitHub availability.

Sources inspected 2026-10-05: [GitHub container registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [attestation API and verification limits](https://docs.github.com/en/rest/repos/attestations), [current official attestation action](https://github.com/actions/attest), and [CLI verification policy](https://cli.github.com/manual/gh_attestation_verify).
