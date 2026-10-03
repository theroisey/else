---
type: decision
status: in-review
created: 2026-10-03
tags:
  - security
  - ci
  - dependencies
---

# Persistent Dependency Security Gate

Issue #100 under #30 adds a sixth read-only CI prerequisite, Dependency security. Publication depends on all six verification jobs and retains sole package-write authority/main-only event gating/exact tested image promotion. No deployment capability or application dependency changes are added.

Full npm 11.19.0 lock audit explicitly includes development dependencies and rejects every severity (`--audit-level=info`). Go 1.27.1 installs pinned official govulncheck v1.8.0, observed upstream tag `709015412431dd2b5b28a53c06c70bc02d49074c`; its immutable go.mod/doc.go were reviewed before code. Normal and integration-tagged source scans include tests but execute no database tests. Both symbol and package levels run in both configurations; any vulnerable imported package fails even if uncalled. Verbose module advisories remain visible for scoped disposition. Ordinary text output preserves vulnerability/error failure; official JSON/SARIF/VEX output can return success with findings and must not become a gate by itself.

The shell wrapper stops on any scan failure. Synthetic scanner tests exercise finding/fetch/package failures at every scan stage; they do not claim vulnerability evidence. The publication prerequisite test plus actionlint guards the declared job contract and YAML/expression validity. CI's first symbol scan reported zero affected symbols/imported packages but one module advisory. #102's immutable source/import review identifies it as unused OpenPGP with no fixed version, leading to package gates and explicit non-applicability rather than blanket module rejection or advisory-ID filtering. The attempted module-only invocation also incorrectly supplied patterns and was removed. CI caught a PATH export assignment masking command status; split assignment/export preserves failure. Local actionlint without ShellCheck is less complete than the CI check.

The actual managed-workspace scan remains blocked by its enforced `vuln.go.dev` destination policy. No bypass, incomplete database, suppression or empty-finding success is allowed. CI has supplied genuine initial symbol results; final four-scan/exact-head gate evidence is still required before ready. Current source/symbol analysis has upstream reflection/unsafe and conservative-call limits. Successful scans are point-in-time evidence, not certification. Keep #30 open until actual final scan results and remaining threat dispositions are reconciled.

- [[Implemented System Threat Review]]
- [[Unused OpenPGP Advisory Disposition]]
- [[CI and Publication]]
- [[Remaining Roadmap]]
- [CI contract](../../docs/ci.md)
- [Official scanner guidance](https://github.com/golang/vuln/blob/709015412431dd2b5b28a53c06c70bc02d49074c/cmd/govulncheck/doc.go)
