# Single Application Image

Issue: [#32](https://github.com/theroisey/else/issues/32).

The user requires exactly one Docker application image and no new issues. Track subsequent work in existing issues. PostgreSQL is infrastructure, separate from the application artifact.

The root multi-stage Dockerfile builds React and static Go binaries. One scratch runtime runs one Go process, serving built UI and versioned API on a shared origin. Migration, bootstrap and credential-rotation binaries are packaged in this same image and require explicit entrypoint overrides and separate authorized database identities. The API never runs migrations or operator commands during startup.

Go applies the existing strict CSP/frame/nosniff/referrer policy from an embedded JSON contract, shared with security verification infrastructure. Frontend artifacts are bounded, confined and snapshotted at startup; unknown files, symlinks, source maps and credentials are refused. API/private errors remain no-store; public immutable snapshot content uses ETag revalidation without assuming filename immutability across rollback.

Compose uses read-only nonroot application/tool containers with no capabilities and no privilege escalation. CI retains all six gates, actual TLS/privilege/recovery/key-source checks and exact build metadata verification. It archives and publishes only the tested application image to ghcr.io/theroisey/else; SHA/version/main-advance protections remain intact. Historical split repositories are no longer promoted.

Each replica holds at most 64 MiB of static assets, plus normal runtime and bounded password work. A compatible managed Go container platform with trusted HTTPS ingress/private PostgreSQL is required; an ordinary Vercel Node/static runtime cannot run this image. Provider flows and target/edge/capacity/monitoring/ownership acceptance remain separately open. No merge or deployment is implied.

Local verification and exact-head remote evidence must be recorded before readiness. Main run 37193818648 failed before runner assignment, without executed test steps; its cause is unverified and must not be attributed to source changes or billing without annotations.
