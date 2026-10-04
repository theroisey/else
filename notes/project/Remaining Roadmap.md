---
type: roadmap
status: active
updated: 2026-10-04
tags: [roadmap, dependencies]
---

# Remaining Roadmap

The user requests completing existing issues step by step, **only main**, and **one application Docker image**, without new issues. These instructions supersede historical branch/PR plans. Production traffic approval remains separate. Existing decisions and historical CI proofs remain in their linked records.

GA4 #26 is closed after integrated durable synchronization and measured workspace. WooCommerce #27 is closed after the owner merged PR128; main `289dfc13ac46202f2f4d262f1538af20f67cdf4b` passed all six CI gates plus tested single-image publication in run37220166845. Every obsolete committed branch was verified in main before reference cleanup. Only main remains locally and on GitHub; preserved auxiliary verification worktrees are detached. The earlier runner-admission failure is resolved.

| Existing issue | Remaining acceptance |
| --- | --- |
| #25 | Meta Graph v26.0 manual ads_read user-token setup, bounded fixed HTTPS collection, encrypted shared jobs/retention and precise marketing workspace are implemented. Frontend 518 tests, 18 real browser flows, full database race suite (523.670s) and the candidate single-image runtime rehearsal pass. Final main CI/publication evidence is recorded in the existing issue. See [[../decisions/Meta Manual Read Token and Durable Reports|Meta Manual Read Token and Durable Reports]]. |
| #31 | Final 500-client/100-session workload passes 4,700 requests including 3,000 mixed requests across two API replicas, 30 exact persisted task writes/audits, all three stored provider reports and independent worker pools with shared two-job admission. Worst mixed route P95 is 1,334ms, within unchanged 2s budget. Real index plans, responsive/keyboard/request-count evidence and limits are documented; final combined-source main CI remains required. |
| #32 | Current architecture and production operating runbook specify managed OCI hosting plus PostgreSQL, same-origin HTTPS and one artifact for web/worker/operator roles. Finish local/CI verification and operating acceptance records. Actual target account/region/domain, protected production roles/keys, PITR/RPO/RTO acceptance, named on-call ownership and explicit traffic release are predeployment owner actions. See [[../decisions/Main Only Single Image Production Readiness|Main Only Single Image Production Readiness]]. |

The target remains 50–100 initial clients with comfortable 500+ growth, 20–50 initial users and 100+ concurrent readiness. PostgreSQL-backed identity/grants/jobs support stateless replicas; pools, pagination, indexes, exact arithmetic, no-store private caching, bounded SQL/request/crypto/provider work, environment validation, health, errors/logging and immutable publication are reviewed. Local short bursts are screening evidence rather than a sustained production SLA.

Meta authority is explicitly manual compatible read tokens, not an unverified OAuth issuer; GA4 uses operator-provisioned service-account read credentials and WooCommerce read-only REST keys. Successful API access does not prove legal account ownership. Local disconnect immediately fences work, while remote revocation remains a manual provider action. Vendor fixtures are visibly synthetic and never production samples. No credentials, live vendor access, production rollout or achieved recovery objective is claimed.

All six gates must pass at the final main revision, followed by publication of exactly the tested image. Preserve protected history, migrations, diagnostics and exact arithmetic. Record CI-only evidence in existing issues instead of adding commits solely for observed CI results.
