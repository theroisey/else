---
type: decision
status: implemented-design
date: 2026-10-04
issues: [31, 32]
tags: [deployment, performance, operations]
---

# Main Only Single Image Production Readiness

The user explicitly requires one branch (`main`), one application Docker image and completion of existing issues without new issues. This supersedes historical frontend/backend branch guidance. The owner merged WooCommerce PR128; all obsolete committed work was verified in main before reference removal. Main `289dfc1` passed all six gates and tested image publication in run37220166845. Future publication still requires every gate; main-only work does not waive security, migrations, audits or production approval.

The reference target is a managed OCI container host with managed PostgreSQL at one HTTPS origin, preserving the required Go API and single artifact. Built React, API, migrations, bootstrap, key operator, health command and analytics worker all use the same immutable digest. Two initial web replicas use ten-connection pools; two separate workers use two each. Four web replicas plus workers/migration require 45 connections before reserve and replacement overlap. Database-backed sessions/grants/jobs allow horizontal scaling without affinity. Global two-job admission is shared across GA4, WooCommerce and Meta.

[[../project/Remaining Roadmap|Remaining Roadmap]] and the production operating runbook track actual proof. The mixed-workload test extends the existing 500-client fixture with 1,500 strictly normalized synthetic reports, 100 sessions across two compiled API instances, audited task creates and independent worker pools. Actual audited leases represent bounded vendor collection without a DB transaction; no live provider-network throughput or production SLA is inferred. The final local test passes all 4,700 requests, 30 writes/audits and 85 worker polls, with worst mixed P95 1,334ms under the unchanged 2s budget. Actual warm query plans use existing task/overview/snapshot indexes; no speculative index/cache is added. Final main CI remains required.

The operating runbook covers protected configuration/TLS/roles, health, connection/autoscaling budgets, private-response caching, monitoring and incident ownership, durable backup/isolated restore, retained keys/fresh restore accounting and compatible artifact rollback. Local/CI archive restores are real, but the pinned older Meta-only source intentionally fails mixed-provider metadata and is not a generic rollback image. Actual host/backup/PITR objectives, protected roles/key mounts, on-call ownership and traffic release must be accepted on the chosen target. No deployment, provider credentials, live account access or achieved production RPO/RTO is claimed.
