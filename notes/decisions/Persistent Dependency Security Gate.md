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

Full npm 11.19.0 lock audit explicitly includes development dependencies and rejects every severity (`--audit-level=info`). Go 1.27.1 installs pinned official govulncheck v1.8.0, observed upstream tag `709015412431dd2b5b28a53c06c70bc02d49074c`; its immutable go.mod/doc.go were reviewed before code. Normal and integration-tagged source scans include tests but execute no database tests. A final module scan also rejects advisories in unimported/uncalled dependency code. Ordinary text output preserves vulnerability/error failure; official JSON/SARIF/VEX output can return success with findings and must not become a gate by itself.

The shell wrapper stops on any scan failure. Synthetic scanner tests exercise finding/fetch/package failures on the first, second and final module scan; they do not claim vulnerability evidence. The publication prerequisite test plus actionlint guards the declared job contract and YAML/expression validity. CI's first symbol scan reported zero affected symbols/imported packages but one vulnerable module; that narrower success prompted the module gate before ready review. CI also caught a PATH export assignment masking command status; split assignment/export preserves failure. Local actionlint without ShellCheck is less complete than the CI check.

The actual managed-workspace scan remains blocked by its enforced `vuln.go.dev` destination policy. No bypass, incomplete database, suppression or empty-finding success is allowed. CI reports actual advisory/tool/fetch outcomes against its checked-out code before ready review; current source/symbol analysis has upstream reflection/unsafe and conservative-call limits. Successful scans are point-in-time evidence, not certification. Keep #30 open until real scan results and remaining threat dispositions are reconciled.

- [[Implemented System Threat Review]]
- [[CI and Publication]]
- [[Remaining Roadmap]]
- [CI contract](../../docs/ci.md)
- [Official scanner guidance](https://github.com/golang/vuln/blob/709015412431dd2b5b28a53c06c70bc02d49074c/cmd/govulncheck/doc.go)
