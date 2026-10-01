# CI and image publication

Related Issue: [#6](https://github.com/theroisey/else/issues/6). `.github/workflows/ci.yml` runs on PRs targeting main, pushes to main, and manual dispatch. Every job uses an explicit timeout, official Actions pinned to resolved full commit SHAs, and read-only checkout credentials. PRs receive no registry credentials or package-write permission.

## Required checks

| Check | Evidence |
| --- | --- |
| Frontend checks | Node 24.21.0/npm 11.19.0 locked installation, lint, typecheck, tests, production build |
| Backend checks | Go 1.27.1 formatting, vet, race tests, static binary builds; negative publication/tag tests |
| PostgreSQL integration | Existing disposable PostgreSQL runner: migrations, transactions, rollback, role denials, readiness recovery |
| Container integration | Development and static-runtime image builds; explicit migrations, verified database TLS, role denials, same-origin routing, readiness outage/recovery, volume persistence, non-root runtimes |

Configure main's branch rules to require these four check names, PR review, and an up-to-date branch. Select the checks from an actual successful run before enforcing them. This change documents those rules without modifying repository administration. Source checks do not substitute for container/database checks. Fork PR runs have read-only permissions and no registry writes; GitHub may require owner approval before running their code.

The Compose runner archives the committed HEAD into a private temporary directory, generates its own credentials/TLS, chooses a random loopback port and unique project/volume, and cleans up those resources on success or failure. It never reads the developer's `.env` or uses the ordinary project volume. Invoke `sh backend/scripts/test-compose.sh` after committing the source to be tested. The production images are revision-labelled, inspected for non-root runtime users, and saved only after runtime checks succeed. The companion frontend fix makes Vite's dependency/config cache writable by its non-root Node user.

## Publication and aliases

Publication runs only for main push/manual events after all four jobs pass. This is the sole job with `packages: write`; it authenticates to GHCR with GitHub's provided token. No personal access token is required. Its initial publication loads the exact production images saved by the container job from a short-lived same-run artifact; it does not rebuild them. CI run logs, the tested revision label, artifact digest, and GHCR content digests provide infrastructure traceability. Deployment and signed release attestations remain separate work.

Images use `ghcr.io/theroisey/else-frontend` and `ghcr.io/theroisey/else-backend`, with `sha-<full-commit>` and `latest` aliases. Stable versions can be promoted by manually dispatching CI on main with `version: vMAJOR.MINOR.PATCH`; prereleases and leading-zero components are rejected. The entire check suite runs again before promotion. A repeat publication retains an existing SHA image after verifying its revision label; a version alias already assigned to another revision is refused. SHA and version aliases are immutable by this workflow's policy. GHCR administrators can still change tags; production consumers should pin content digests.

Publication jobs serialize. A run whose revision is no longer main's current head publishes its immutable revision but leaves `latest` alone. A registry failure can leave one image published before the other; rerun CI on main to finish without overwriting already-published SHA aliases. Existing version aliases for another revision require a new version, not deletion. Package policy must allow the repository's GitHub token to write its own packages; publication failures remain visible and never trigger deployment.

No image publication is performed from development branches, PRs, or tag pushes. The first main publication requires owner review and merge of this change; it has not occurred during implementation.

## Maintaining pins

Action pins were resolved from official repositories' v4/v5/v3 tags on 2026-10-01. Updates must verify the upstream repository and release, record the reviewed SHA, and rerun checks. Node/npm/Go and application dependencies remain pinned by the repository's version/lock contracts. PostgreSQL is digest-pinned; Node/Go/nginx base-image immutable digest resolution remains incomplete because this environment's Docker Hub pulls are rate-limited. Resolve and validate those digests before treating runtime builds as reproducible release artifacts.

Run `actionlint` against the workflow, `sh -n` on the Compose runner, `bash -n` on publication, and `python3 backend/scripts/test-publication.py` locally. Static validation and simulated publication boundaries do not establish a successful GitHub run or registry upload. Keep Issue #6 open until PR checks and an owner-approved main publication provide that evidence.
