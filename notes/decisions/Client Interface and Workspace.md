---
type: decision
status: owner-merged
created: 2026-10-01
tags:
  - clients
  - frontend
  - authorization
  - accessibility
---

# Client Interface and Workspace

Issue #14 follows owner-merged backend PR #48 at `4efc7e8`. Main run 36927463099 passed all five gates and tested-image publication; both permanent branches were synchronized. Scope was recorded before implementation in [comment 5940812195](https://github.com/theroisey/else/issues/14#issuecomment-5940812195).

Frontend PR #49 is owner-merged at `97aae34`. Main [run 36933129639](https://github.com/theroisey/else/actions/runs/36933129639) passed all five gates and tested-image publication. Both branches were synchronized before [[Task State and Assignee Scope]] (#15). No production deployment was performed.

Lists use authorized API summaries, fixed 25-record UUID keysets and the actual name/tag/status/sort contract. Filters remain in memory and applying them resets cursor history. No totals or name sorting are invented. Contacts/profile details load only after exact-client view checks. Creation requires global create but grants no access; create-only identities submit without collection/detail reads. Edit requires exact view+update; archive requires exact view+archive and explicit confirmation of the captured revision.

Client query keys include actor ID and grant snapshot. A grant reduction cannot reuse a prior list under broader permissions. Existing auth clears private queries on expiry/logout/identity transitions; domain reads additionally reject results after the identity changes. Mutation results validate ID/revision before success. Stale forms keep drafts until explicit reload/discard; archived records retain history with no mutations or restoration.

React Hook Form and Zod are the two new pinned dependencies, serving the bounded full profile/contact/tag form. Ordered contact rows replace atomically with the profile. Tags are one per line (labels can contain commas); notes are one paragraph to match the API's control-character rule. Existing semantic Table serves server pagination; no table library is justified. Client routes load separately, preserving the initial public/login bundle; route-load errors have explicit recovery. Administration/client services share one cookie/CSRF JSON transport with domain-owned path and response validation.

Overview is the sole implemented workspace module. Other modules are plain unavailable text in a compact disclosure, keeping the mobile context short without dead actions or synthetic metrics. Header, breadcrumbs, profile/contacts and record context reuse monochrome tokens and accessible primitives.

Local lint/typecheck, 69 tests, build and production dependency audit pass. All five real-API browser flows pass against a newly created disposable PostgreSQL 17.11 database. Synthetic desktop/tablet/mobile captures verify contained tables/forms/workspace/confirmation. CI supplies final PostgreSQL 18, pinned Chromium and containers. The client viewer uses a dedicated synthetic identity because the prior auth tests consume the original viewer's real five-attempt login budget; production throttling remains unchanged. No production deployment is authorized.

- [[Client Records and Scope History]]
- [[Application Shell and Session Recovery]]
- [[Interface Foundation]]
- [Interface contract and screenshots](../../docs/client-interface.md)
