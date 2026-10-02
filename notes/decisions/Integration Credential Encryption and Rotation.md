---
type: decision
status: implemented-pending-owner-review
created: 2026-10-03
tags:
  - integrations
  - security
  - encryption
---

# Integration Credential Encryption and Rotation

Parent #24 spans durable connections, authorization, encryption, OAuth/SSRF, remote revocation and synchronization. Provider Issues #25–#27 still propose providers. Split the foundation into separately reviewable slices; #68 owns only standard-library credential encryption/key rotation and the parent design. The [parent policy](https://github.com/theroisey/else/issues/24#issuecomment-5961601808) and #68 authorization/key policy preceded code. Parent acceptance remains incomplete.

The backend credential package binds AES-256-GCM ciphertext to immutable client/connection/provider/purpose metadata and authenticates version/key label. Random nonces come from the standard library. A bounded immutable key ring accepts one active version and retained old keys; authenticated rewrap issues fresh ciphertext. Strict bounded JSON rejects duplicate/aliased fields and discards parser details. Default formatting/logging/JSON exposes no key/envelope bytes.

An unsupported `%p` formatting diagnostic can bypass an outer formatter and expand value fields. Private state indirection prevents this; regression tests include pointers, values and containing structs, both log handlers and explicit persistence-buffer copies. Redaction is not protection against deliberately extracted buffers or process-memory inspection.

Keys are independently provisioned outside the database and unique per environment. The future storage owner must enforce an encryption budget below 2^32 messages/key across processes/restarts, atomic revision-checked rewrap batches and retention/restore proof before retiring old keys. This primitive has no global counter, durable rotation or startup wiring. Go JSON/cipher/runtime copies cannot be guaranteed erased.

No provider call, route, permission grant, schema/migration, connection/sync success or durable audit event is introduced. Encryption is not authorization; persisted metadata must be resolved under current exact-client grants first. Remaining boundaries and verification requirements are explicit in [the integration guide](../../docs/integrations.md). No merge/deployment is authorized.

Overview PR #67 is owner-merged at `15aa7012ecaf6740900f0f753cf0151908dce619`; both branches fast-forwarded. Main [run 37065393667](https://github.com/theroisey/else/actions/runs/37065393667) passed. The first integration slice follows this baseline.

Local verification passes: ten credential unit tests plus two fuzz targets/seeds, all backend race tests, vet and static builds. Bounded fuzz sessions completed 491,423 envelope cases and 347,216 key-ring cases without failure. Final-head CI is required before this slice becomes ready for owner review; existing database/container/browser gates do not prove the still-unimplemented provider lifecycle.

- [[Authorization and Client Scope]]
- [[Audit Infrastructure]]
- [[Identity and Sessions]]
- [[Overview Interface and Bounded Refresh]]
