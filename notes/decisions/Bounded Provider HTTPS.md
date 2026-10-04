---
type: decision
status: in-review
created: 2026-10-04
tags:
  - integrations
  - security
  - runtime
---

# Bounded Provider HTTPS

#121 supplies an independent internal request boundary after owner-integrated frontend #117 and selected catalog #119 (all six PR gates at dd4b9ba in 37192905613). Main is 94c6228401d3f00b8581c906c1e8b6743157b09e and both permanent branches synchronized. Trusted canonical HTTPS origins, conservative all-address DNS checks/pinned IP dialing, normal original-host TLS, no redirects/proxy/cookies and explicit bounded inputs/responses protect later adapters. Syntax/public-IP/TLS is not provider ownership or authorization.

One shared two-slot admission covers actual body consumption and started DNS/TCP/TLS cleanup. No queue or detached application request. Crucial source/runtime finding: net/http transport detaches its internal dial context from request deadlines for connection pooling. Keep-alive is disabled; isolated per-request transport binds DNS/TCP/TLS to the actual budget and waits for started dial cleanup before returning capacity. Tests delay canceled DNS acknowledgement and prove overload persists until cleanup. Total 10s, DNS/TCP 2s, TLS 3s, headers 4s, response 64 KiB, request 16 KiB; earlier caller deadlines win.

Real isolated TLS/race tests pass, including incorrect certificates, DNS rebinding/private mixed answers, no-secret URLs, redirect/status/header/compression/body/JSON boundaries, body/DNS slot lifetime/cancellation/recovery. All Go race/vet/integration-vet/static builds pass; canonical-origin fuzzing passes 419,411 executions in 30 seconds (three workers). [Guide](../../docs/provider-https.md) records conservative network policy, handshake overhead, aggregate replica/background/ownership/adapter dependencies and no live call/success claims. Final CI evidence belongs in #121/its PR.

Post-merge main execution has an external runner-admission blocker: 1baee6f run 37192595128 passed all six tests but publication failed with no runner/steps; 94c6228 run 37193818648 failed every test job with runner_id=0/empty steps, then skipped publication. Logs unavailable; check annotations exist but the installed connector excludes their endpoint. Ask the owner for the annotation; do not diagnose billing or weaken gates without evidence. PR #121 stays draft until all six exact-head gates run/pass; restore current main test/publication separately under existing immutable policy.

- [[Selected Provider Catalog and Binding]]
- [[Official Provider Sources]]
- [[Remaining Roadmap]]
