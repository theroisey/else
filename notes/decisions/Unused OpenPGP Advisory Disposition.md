---
type: security-review
status: in-review
created: 2026-10-04
tags:
  - security
  - dependencies
---

# Unused OpenPGP Advisory Disposition

Issue #102 records GO-2026-5932 from #100 / PR #101's genuine CI scans. The [official reviewed OSV](https://github.com/golang/vulndb/blob/5cd8418cf9c867d344fda07a73ea844b0f34bca2/data/osv/GO-2026-5932.json) at immutable commit `5cd8418cf9c867d344fda07a73ea844b0f34bca2` flags only x/crypto's unmaintained OpenPGP root/subpackages across every version, with no fixed release. It does not flag Argon2.

Both normal and integration-tagged `go list -deps -test` import graphs contain zero OpenPGP dependencies and do contain the reviewed password-hashing Argon2 package. Real govulncheck v1.8.0 source/test scans report zero affected symbols and zero vulnerable imported packages, while retaining one module advisory. Current disposition is **non-applicable to compiled dependencies**, not an entirely advisory-free module or a suppressed advisory.

Do not replace/fork/copy password crypto to remove unrelated metadata. Four ordinary-text symbol/package scans cover both configurations; package-level failure blocks future vulnerable imports even when no affected symbol is called. The warning stays in verbose output, with no advisory-ID ignore list or special exit-code exception. Reassess on dependency/build-tag/import changes and require current actual CI evidence. Parent #30 remains open for final review.

- [[Persistent Dependency Security Gate]]
- [[Implemented System Threat Review]]
- [[Identity and Sessions]]
- [Go issue referenced by advisory](https://go.dev/issue/44226)
