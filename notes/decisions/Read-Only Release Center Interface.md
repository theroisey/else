---
type: decision
status: implemented-pending-owner-review
created: 2026-10-03
tags:
  - releases
  - frontend
  - security
---

# Read-Only Release Center Interface

Issue #93 records UI/authorization/evidence policy before code under parent #29. It integrates backend #92's tested stamp/read foundation; backend PR #94 and the separate frontend PR require owner review. No update/deployment capability is introduced.

Current global releases.view protects route, navigation, shell indicator and requests. The API is the only source. Page/shell share an identity/grant-partitioned query with strict exact response validation, no-store, bounded cancellation and no automatic retry. Permission/session refresh removes metadata after revocation/expiry; a delayed old-identity response cannot populate the new context. No browser persistence or caller-supplied evidence source exists.

The UI labels the running API revision and exact UTC build time. Missing valid stamps are unavailable; approved/latest release, image provenance and deployment stay separately unavailable. No badge implies rollout success or artifact verification. Wide-screen shell shows a restrained short API revision; mobile navigation retains the page and long values wrap.

Real browser verification uses a disposable synthetic release-only actor, actual compiled stamp, real login/authorization and persisted audit non-mutation. It checks keyboard and desktop/mobile overflow, then revokes the global grant and verifies metadata disappears/API denial. The runner derives the tested checkout revision and one build time rather than supplying static fixture metadata. Full unit and all five CI gates remain required before readiness.

See [interface contract](../../docs/release-interface.md), [[Immutable Build Metadata and Release Reads]], [[Application Shell and Session Recovery]], and [[Remaining Roadmap]].
