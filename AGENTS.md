# Engineering contract

Roisey Else is a client operations platform. Preserve real behavior, private data, exact financial history, and current permission boundaries. Work on `main` only; do not create feature, frontend, backend, or review branches. Do not force-push, erase unrelated changes, remove customer volumes, or deploy production without explicit authorization. Existing push authorization does not authorize deployment.

## Read before changing

Read the relevant current notes: [architecture](notes/architecture.md), [domain contracts](notes/domains.md), [provider boundaries](notes/providers.md), [operations and migration](notes/operations.md), and [frontend](notes/frontend.md). Inspect the implemented consumer and its tests before changing a contract. Issues are the scope/evidence record; reference the existing issue for follow-up work. Create an issue only when the owner permits it. Record significant financial, authorization, encryption, import, and recovery policy before implementation.

## Architecture

- One custom application image. Rust/Pingora is the sole HTTP process and PID 1, serving built React assets, `/api/v1`, and health endpoints. Background provider tasks run within this process.
- SQLite is the durable relational authority. Use STRICT tables, foreign keys, WAL, FULL durability, indexed bounded reads, and admitted transactions. Each data volume has one serving process; do not bypass its filesystem lease or promise horizontal SQLite replicas.
- Redis is optional official infrastructure for disposable report caching. It never owns sessions, permissions, jobs, leases, finance, audit, or encryption budgets. Outage falls back to SQLite.
- Compile/check frontend assets and the static Rust binary before Docker. Runtime has no source, toolchain, Node, database server, shell, supervisor, or updater. Keep fonts and third-party notices.
- Registry updates stay in external Make/Compose operations. Preserve exact tested-image promotion and attestation; do not add app release/version polling.

## Backend boundaries

Separate transport (`api*`, `server`), domain services, `security`, `db`, `audit`, and provider interpreters/collectors. Reuse existing helpers. Do not add a framework or generic JSON database to avoid explicit domain rules.

Every protected request rechecks an active session/user and current grants. Every domain lookup binds the actual client and parent. Write checks occur after acquiring the IMMEDIATE transaction, including historical assignees, resource eligibility, lifecycle, revisions, and generation fences. Role names, creators, owners, and UUID knowledge confer no access. View and write are independent unless the particular public contract requires both.

Mutations and typed safe audits commit together. Never serialize free-form text, credentials, account IDs, payment references, costs, or raw errors into audit/logs. Audit, payments, pricing versions/copied terms, grant history, and encryption accounting remain retained and guarded. Reads do not generate business audits.

Money, counts, quantities, revisions, and provider decimals use their exact established string/integer contracts. Use checked wide intermediates and per-step half-up pricing. Do not use floating-point money, combine currencies, infer payment/revenue, or blindly retry a mutation. Preserve original command IDs/payloads on uncertain financial outcomes.

Keep configuration bounded and explicit, errors fixed/redacted, CSRF tied to the current session, and Origin exact. Keep admission permits attached to actual blocking work after cancellation. Provider requests must remain outside database transactions and user request paths.

## Frontend boundaries

Preserve the official owner-supplied SVG geometry, semantic light/dark tokens, CSP-safe theme bootstrap, self-hosted typography, all five locales, keyboard focus, reduced motion, and contained responsive tables/drawers. Font Awesome free-solid is the sole icon style. Do not add inline/eval allowances, remote fonts, another icon set, fake data, or unimplemented destinations.

Strictly validate bounded DTOs, client/parent/period binding, ordered pages, and exact strings. Partition private queries by actor/grants/client/selection and reject departed or obsolete results. Preserve drafts and original revisions across allowed background refresh; conflicts and unknown writes require explicit reconciliation. Credentials clear before transport and never enter React/query state, persistence, URLs, or screenshots.

## Data and operations

New SQLite migrations are additive and checksum-verified; never edit an applied migration on a deployed installation. No automatic downgrade or history deletion. Original PostgreSQL v28 is retained only as an import catalog and compressed test oracle. Export from a stopped-application isolated clone, verify counts/histories/ciphertext, import into empty replacement storage, and preserve original data for rollback.

Use supported online backups. Restore/import must refuse populated targets, fail closed on interrupted verification, retain every required decryptor, and introduce independent fresh active material before encryption. A live inventory does not authorize key retirement. Protect operator input/output; actor IDs are audit attribution, not operator authentication.

## Verification and delivery

Run checks appropriate to the change and keep failures visible. Normal gates are `make check`; important system changes also require actual HTTP, browser, import/cache, image/recovery, capacity, and Compose checks. Use only explicitly owned disposable fixtures/volumes and free loopback ports. Never use customer credentials/data or disturb unrelated developer servers.

CI keeps six required contexts: Frontend checks, Backend checks, Browser authentication, Dependency security, PostgreSQL integration, and Container integration. PostgreSQL integration is now the conserved import compatibility oracle. Frontend/runtime artifacts feed one image build; actual image/browser/recovery/capacity checks precede publication. Publication promotes the saved exact image, verifies immutable aliases/current-main policy, and signs/verifies its registry digest without rebuilding. Keep full pinned Action/toolchain/container references and genuine dependency scanner failures. The narrowly reviewed Pingora compile-macro maintenance advisory remains visible; new findings or changed scope fail.

Use reviewable conventional commits. Update the affected concise notes and customer README when behavior changes. Report executed results and their limits, exact source/image evidence, and anything still blocked. Never call a worktree test a published artifact, synthetic provider data live access, a short load rehearsal an SLA, or publication a production rollout.
