---
type: decision
status: owner-merged
created: 2026-10-03
tags:
  - integrations
  - frontend
  - authorization
---

# Integration View Permission Compatibility

Issue #70 is the frontend prerequisite for parent #24's next metadata backend. Strict administration catalog/role parsers reject absent frontend permission definitions; the backend must not introduce `integrations.view` before this consumer is owner-merged. Identity parsing already preserves structurally valid future keys. Follow the earlier finance permission-consumer ordering (#61).

Add only client-defined integration view to the frontend scope map. View, existing integrations.manage, analytics.view and clients.view remain independent; no implication, role seed or backend grant exists. Exact-client access and valid explicit context for global assignments retain the current policy. Delegation requires roles.manage plus control of every applicable permission, and client grants cannot become global authority. The future metadata backend separately requires both clients.view and integrations.view for one real client.

Old and expanded catalog/role responses are accepted. Malformed scope bindings, duplicate keys and unknown integration catalog/role keys are rejected; unknown identity keys remain inert. Regression tests cover this contract and complete-authority delegation. No frontend destination, connection action, backend change, credential handling, synchronization or provider call enters this slice. Parent #24 remains incomplete.

Credential PR #69 is owner-merged at `3768b4d276fa4c5e9651df08eb0e52001d08248c`; both branches synchronized and main [run 37103885719](https://github.com/theroisey/else/actions/runs/37103885719) passed. Final-head CI precedes owner review; no agent merge/deployment is authorized.

Local verification passes: all 391 frontend tests (eleven new permission/delegation cases), lint, strict typecheck and production build. No layout or browser interaction changes enter the slice; existing real-API browser/database/container regressions run in CI. PR #71 is owner-merged at `c812882798be05eab62cd9f787e2e67585ae437b`; final-head [run 37104624313](https://github.com/theroisey/else/actions/runs/37104624313) and main [run 37105863163](https://github.com/theroisey/else/actions/runs/37105863163) passed all five jobs. Both permanent branches synchronized before #72. Meta Ads is the planned first provider recorded in #25; actual scopes/endpoints/account verification remain prerequisites of its concrete adapter.

- [[Integration Connection Metadata and Read Boundaries]]

- [[Integration Credential Encryption and Rotation]]
- [[Authorization and Client Scope]]
- [[User and Role Administration]]
