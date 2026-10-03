---
type: security-review
status: in-review
created: 2026-10-04
tags:
  - frontend
  - security
  - csp
---

# Frontend Browser Security

Issue #103 resolves the shipped static server's missing CSP/frame defenses from #30. Enforced same-origin CSP rejects inline/eval code, inline styles, objects, base overrides, framing and external forms; data images support the bundled favicon. DENY/nosniff/no-referrer apply with nginx always; upstream nosniff is hidden to avoid duplicates. No HSTS or production TLS claim without a target.

Font Awesome official CSS is bundled and auto injection disabled before rendering. A real built-artifact Chromium probe exposed Zod's caught Function capability probe as a script-src/eval violation. Entrypoint-only jitless configuration was too late for shared production chunks. Every schema now imports the configured Zod instance from lib/validation, and lint rejects direct imports elsewhere. Validation semantics/dependencies stay unchanged; the full existing unit suite exercises this configuration. SVG computed display is legitimately blockified inside flex buttons; browser checks verify icon dimensions/box-sizing/alignment instead.

Actual nginx route/asset/error/proxy headers are checked in Container integration. Separate built-artifact preview reads exact nginx policy and uses real API/disposable PostgreSQL for Chromium compatibility/controlled attack denial. Public/failed-login checks preserve the original 15 successful-session/audit fixtures; those full flows now use the same secured built artifact. Owned resource cleanup and occupied-port refusal remain mandatory. Local focused Chromium passes with zero spontaneous violations and all tested attacks blocked; exact-head Browser/Container and other four gates are required before ready. Never describe preview as actual nginx, production rollout or exhaustive exploit proof.

The eval denial probe must run from an ordinary same-origin script, served only by test-preview middleware with fixed synthetic content. DevTools evaluation may bypass code-generation CSP; it is unsuitable as direct eval-denial proof. No probe endpoint enters production nginx/artifact.

- [[Implemented System Threat Review]]
- [[Persistent Dependency Security Gate]]
- [[Remaining Roadmap]]
- [Browser security guide](../../docs/browser-security.md)
