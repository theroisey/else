# Development roadmap

GitHub Issues are the source of implementation scope. This index records the dependency-aware roadmap created after the initial repository audit on 2026-10-01. It is a plan, not a list of shipped capabilities.

Current slice: [#11](https://github.com/theroisey/else/issues/11), monochrome tokens and accessible UI primitives on frontend. Issues #1–#9 are owner-merged. Both development branches were synchronized to RBAC merge `576a48f` before interface work. [The interface foundation](interface-foundation.md) records token, primitive and accessibility decisions.

## Verified starting state

No local or remote commits, no remote branches, no Issues or Actions, and no application source, Docker services, database schema, or migrations existed. Existing local AGENTS.md and Obsidian settings were preserved. See [architecture](architecture.md) and [the required branch bootstrap decision](repository-bootstrap.md).

## Milestones and scope

### v0.1 — Foundation

Repository conventions, runnable foundations, authentication, authorization, audit infrastructure, design system, and CI.

| Issue | Scope | Dependencies |
| --- | --- | --- |
| [#1](https://github.com/theroisey/else/issues/1) | Establish repository conventions and architecture baseline | Empty main initialization approved and completed |
| [#2](https://github.com/theroisey/else/issues/2) | Build Go HTTP, configuration, logging, and health foundation | [#1](https://github.com/theroisey/else/issues/1) |
| [#3](https://github.com/theroisey/else/issues/3) | Initialize typed React frontend and test tooling | [#1](https://github.com/theroisey/else/issues/1) |
| [#4](https://github.com/theroisey/else/issues/4) | Establish PostgreSQL and reversible migration tooling | [#2](https://github.com/theroisey/else/issues/2) |
| [#5](https://github.com/theroisey/else/issues/5) | Provide reproducible three-service Docker development environment | [#2](https://github.com/theroisey/else/issues/2), [#3](https://github.com/theroisey/else/issues/3), [#4](https://github.com/theroisey/else/issues/4) |
| [#6](https://github.com/theroisey/else/issues/6) | Add pull-request gates and main-only GHCR publication | [#5](https://github.com/theroisey/else/issues/5) |
| [#7](https://github.com/theroisey/else/issues/7) | Implement transaction-aware append-oriented audit infrastructure | [#2](https://github.com/theroisey/else/issues/2), [#4](https://github.com/theroisey/else/issues/4) |
| [#8](https://github.com/theroisey/else/issues/8) | Implement secure identity and cookie sessions | [#7](https://github.com/theroisey/else/issues/7) |
| [#9](https://github.com/theroisey/else/issues/9) | Implement permission-based RBAC and client-scope policy boundaries | [#8](https://github.com/theroisey/else/issues/8) |
| [#10](https://github.com/theroisey/else/issues/10) | Deliver authorized user and role administration | [#9](https://github.com/theroisey/else/issues/9), [#12](https://github.com/theroisey/else/issues/12) |
| [#11](https://github.com/theroisey/else/issues/11) | Define monochrome tokens and accessible UI primitives | [#3](https://github.com/theroisey/else/issues/3) |
| [#12](https://github.com/theroisey/else/issues/12) | Build real login and permission-aware application shell | [#6](https://github.com/theroisey/else/issues/6), [#8](https://github.com/theroisey/else/issues/8), [#9](https://github.com/theroisey/else/issues/9), [#11](https://github.com/theroisey/else/issues/11) |

### v0.2 — Client Management

Authorized client records and an operational client workspace.

| Issue | Scope | Dependencies |
| --- | --- | --- |
| [#13](https://github.com/theroisey/else/issues/13) | Implement isolated client records and audited client API | [#9](https://github.com/theroisey/else/issues/9), [#7](https://github.com/theroisey/else/issues/7) |
| [#14](https://github.com/theroisey/else/issues/14) | Deliver client table, validated forms and workspace navigation | [#13](https://github.com/theroisey/else/issues/13), [#12](https://github.com/theroisey/else/issues/12) |

### v0.3 — Operations

Tasks, planning, reminders, activity, and audit inspection.

| Issue | Scope | Dependencies |
| --- | --- | --- |
| [#15](https://github.com/theroisey/else/issues/15) | Implement audited client task API and state transitions | [#13](https://github.com/theroisey/else/issues/13) |
| [#16](https://github.com/theroisey/else/issues/16) | Deliver client task table and task editing flow | [#15](https://github.com/theroisey/else/issues/15), [#14](https://github.com/theroisey/else/issues/14) |
| [#17](https://github.com/theroisey/else/issues/17) | Implement client planning and linked milestones | [#15](https://github.com/theroisey/else/issues/15), [#16](https://github.com/theroisey/else/issues/16) |
| [#18](https://github.com/theroisey/else/issues/18) | Implement timezone-aware client reminders | [#14](https://github.com/theroisey/else/issues/14), [#9](https://github.com/theroisey/else/issues/9), [#7](https://github.com/theroisey/else/issues/7) |
| [#22](https://github.com/theroisey/else/issues/22) | Implement human-readable client activity history | [#13](https://github.com/theroisey/else/issues/13), [#15](https://github.com/theroisey/else/issues/15), [#7](https://github.com/theroisey/else/issues/7), [#14](https://github.com/theroisey/else/issues/14) |
| [#28](https://github.com/theroisey/else/issues/28) | Deliver authorized audit viewer and safe before/after inspection | [#7](https://github.com/theroisey/else/issues/7), [#9](https://github.com/theroisey/else/issues/9), [#14](https://github.com/theroisey/else/issues/14) |

### v0.4 — Finance

Exact collections, payment history, historical pricing, and operational summaries.

| Issue | Scope | Dependencies |
| --- | --- | --- |
| [#19](https://github.com/theroisey/else/issues/19) | Implement exact collections and transactional payment history | [#13](https://github.com/theroisey/else/issues/13), [#7](https://github.com/theroisey/else/issues/7), [#9](https://github.com/theroisey/else/issues/9) |
| [#20](https://github.com/theroisey/else/issues/20) | Deliver finance summary and payment collection workflows | [#19](https://github.com/theroisey/else/issues/19), [#14](https://github.com/theroisey/else/issues/14) |
| [#21](https://github.com/theroisey/else/issues/21) | Implement versioned client pricing and immutable billing snapshots | [#19](https://github.com/theroisey/else/issues/19), [#20](https://github.com/theroisey/else/issues/20) |
| [#23](https://github.com/theroisey/else/issues/23) | Deliver actionable client operational overview | [#16](https://github.com/theroisey/else/issues/16), [#18](https://github.com/theroisey/else/issues/18), [#20](https://github.com/theroisey/else/issues/20), [#21](https://github.com/theroisey/else/issues/21), [#22](https://github.com/theroisey/else/issues/22) |

### v0.5 — Analytics & Integrations

Secure provider adapters and measured marketing, web analytics, and commerce data.

| Issue | Scope | Dependencies |
| --- | --- | --- |
| [#24](https://github.com/theroisey/else/issues/24) | Establish secure integration connection and synchronization boundaries | [#13](https://github.com/theroisey/else/issues/13), [#7](https://github.com/theroisey/else/issues/7), [#9](https://github.com/theroisey/else/issues/9) |
| [#25](https://github.com/theroisey/else/issues/25) | Implement first marketing adapter and measured marketing workspace | [#24](https://github.com/theroisey/else/issues/24), [#14](https://github.com/theroisey/else/issues/14) |
| [#26](https://github.com/theroisey/else/issues/26) | Implement first web analytics adapter and measured analytics workspace | [#24](https://github.com/theroisey/else/issues/24), [#14](https://github.com/theroisey/else/issues/14) |
| [#27](https://github.com/theroisey/else/issues/27) | Implement first commerce adapter and measured commerce workspace | [#24](https://github.com/theroisey/else/issues/24), [#14](https://github.com/theroisey/else/issues/14) |

### v0.6 — Release Management

Version metadata and read-only deployment visibility.

| Issue | Scope | Dependencies |
| --- | --- | --- |
| [#29](https://github.com/theroisey/else/issues/29) | Implement build version metadata and read-only Release Center | [#6](https://github.com/theroisey/else/issues/6), [#12](https://github.com/theroisey/else/issues/12), [#7](https://github.com/theroisey/else/issues/7), [#9](https://github.com/theroisey/else/issues/9) |

### v1.0 — Production Ready

Security, critical-flow tests, performance evidence, and deployment readiness.

| Issue | Scope | Dependencies |
| --- | --- | --- |
| [#30](https://github.com/theroisey/else/issues/30) | Harden security boundaries against documented threat model | [#10](https://github.com/theroisey/else/issues/10), [#13](https://github.com/theroisey/else/issues/13), [#19](https://github.com/theroisey/else/issues/19), [#21](https://github.com/theroisey/else/issues/21), [#24](https://github.com/theroisey/else/issues/24), [#28](https://github.com/theroisey/else/issues/28), [#29](https://github.com/theroisey/else/issues/29) |
| [#31](https://github.com/theroisey/else/issues/31) | Add critical-flow end-to-end and performance readiness proof | [#23](https://github.com/theroisey/else/issues/23), [#25](https://github.com/theroisey/else/issues/25), [#26](https://github.com/theroisey/else/issues/26), [#27](https://github.com/theroisey/else/issues/27), [#28](https://github.com/theroisey/else/issues/28), [#29](https://github.com/theroisey/else/issues/29) |
| [#32](https://github.com/theroisey/else/issues/32) | Document deployment, backup/restore and production readiness | [#30](https://github.com/theroisey/else/issues/30), [#31](https://github.com/theroisey/else/issues/31) |

## Sequential dependency order

#1, #2, #3, #4, #5, #6, #7, #8, #9, #11, #12, #10, #13, #14, #15, #16, #17, #18, #22, #28, #19, #20, #21, #23, #24, #25, #26, #27, #29, #30, #31, #32.

This is one valid order that honors prerequisites and milestone grouping. Independent ready Issues can be scheduled separately; each execution completes one coherent slice. Numeric Issue order is not dependency order: user administration #10 follows the real login/shell #12, which follows design primitives #11.

## Coordination rules

- Backend Issues develop on backend; frontend Issues develop on frontend. Root documentation and shared infrastructure use the owning coordinated PR. Keep unrelated implementation out of each branch.
- Cross-cutting Issues first settle their API and security decisions, then use separately reviewable backend/frontend PRs. A dependency must deliver the required contract before its consumer starts.
- Audit infrastructure precedes authenticated administrative and client mutations. Backend authorization and client scope precede exposing client records.
- Financial policy, integration credential handling, and rollout decisions are explicitly recorded in their Issues before implementation. Proposed providers are not approved connections.
- Audit viewer #28 and activity #22 belong to the operations milestone even though later Issue numbers were assigned. They do not depend on analytics integrations.
- Synchronize both development branches after a merge to main. Never force-push or implicitly deploy.

## Scope limits

Docker starts in #5; CI/GHCR starts in #6. The first baseline does not install dependencies, generate business schemas, or implement runtime behavior. Issue #2 adds only the Go HTTP foundation. Command palette, task attachments/comments, recurring reminder delivery, additional providers, and executable release rollouts require separately scoped Issues.

## Current status

Issues #1–#9 are merged. Issue #11 adds shared monochrome/semantic tokens, accessible Button/TextField/Status/Table/Dialog primitives, a non-operational review route, component interactions, measured contrast and responsive Chromium evidence. The authenticated shell, user/role administration routes, client records, recovery and business domains remain later Issues. No production deployment is authorized or performed.
