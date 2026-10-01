# AGENTS.md

## 1. Project Identity

**Project:** Roisey Else  
**Repository:** `git@github.com:theroisey/else.git`

Roisey Else is a centralized business and client management platform.

It is intended to be the operational control panel for managing clients, their financial information, tasks, plans, reminders, marketing performance, e-commerce performance, analytics, pricing, users, permissions, releases, and system activity.

This is not a simple CRM.

The application should evolve into a modular operations platform where each client has a dedicated workspace containing all relevant business, financial, operational, and analytical information.

---

# 2. Agent Operating Principles

Every coding agent working on this repository MUST follow these principles.

1. Understand the requested feature before modifying code.
2. Inspect the existing repository and architecture before creating new files.
3. Never blindly rewrite working code.
4. Prefer extending existing abstractions over creating duplicate implementations.
5. Every meaningful development task MUST be represented by a GitHub Issue.
6. Development must progress incrementally.
7. Do not implement unrelated features in the same task.
8. Keep frontend and backend responsibilities separated.
9. Security, authorization, auditability, and data integrity are first-class requirements.
10. Never expose secrets, credentials, access tokens, API keys, private keys, or sensitive customer data.
11. Do not commit generated secrets or `.env` files.
12. Do not force-push unless explicitly instructed.
13. Do not bypass tests, linters, authorization, migrations, or audit logging to make a feature work faster.
14. Do not silently introduce large architectural changes. Document them in the associated GitHub Issue.
15. Prefer maintainable production-quality implementations over prototypes.

When multiple valid technical approaches exist, prefer the one that:

- has lower long-term maintenance cost;
- has fewer hidden side effects;
- is easier to test;
- has clear boundaries;
- scales to additional clients and integrations;
- preserves auditability.

---

# 3. Git Branch Strategy

The repository has exactly three permanent branches:

- `main`
- `frontend`
- `backend`

## main

`main` is the production branch.

Rules:

- Never develop directly on `main`.
- Never commit directly to `main`.
- Changes reach `main` through Pull Requests.
- `main` must always remain deployable.
- Successful merges into `main` trigger production container builds.
- Releases and production images originate from `main`.

## frontend

`frontend` is created from `main`.

Frontend application code belongs under:

```text
/frontend
```

Frontend development must primarily happen on the `frontend` branch.

The frontend branch must not contain unrelated backend implementation changes.

After frontend work is complete:

```text
frontend -> Pull Request -> main
```

## backend

`backend` is created from `main`.

Backend application code belongs under:

```text
/backend
```

Backend development must primarily happen on the `backend` branch.

The backend branch must not contain unrelated frontend implementation changes.

After backend work is complete:

```text
backend -> Pull Request -> main
```

## Synchronization

Whenever a Pull Request is merged into `main`, the other development branches must be synchronized with the latest `main` before continuing substantial development.

Avoid long-lived divergence between:

```text
main
frontend
backend
```

Never use force pushes to synchronize branches.

---

# 4. GitHub Issues Are the Source of Development Planning

GitHub Issues are the primary planning and task-tracking system for this project.

Do NOT begin a substantial feature without an associated GitHub Issue.

Before implementing a feature:

1. Inspect existing Issues.
2. Search for an Issue covering the requested work.
3. If none exists, create one.
4. Define scope and acceptance criteria.
5. Identify frontend/backend/database/security implications.
6. Break large work into smaller Issues when necessary.
7. Implement only after the scope is clear.

Every Issue should preferably contain:

```markdown
## Summary

## Motivation

## Scope

## Functional Requirements

## Technical Requirements

## Database Changes

## API Changes

## Frontend Changes

## Authorization / Permissions

## Audit Log Requirements

## Acceptance Criteria

## Testing Requirements

## Dependencies

## Out of Scope
```

Use labels where appropriate, such as:

```text
frontend
backend
database
security
auth
rbac
billing
clients
tasks
analytics
marketing
ecommerce
audit-log
devops
release
bug
enhancement
refactor
documentation
```

Large features should use a parent Issue with smaller implementation Issues.

Do not create giant Issues that combine unrelated domains.

---

# 5. Commit Discipline

Commits must be small, meaningful, and focused.

Preferred commit style:

```text
feat(frontend): add client overview dashboard
feat(backend): add client billing endpoints
fix(auth): prevent unauthorized role modification
refactor(audit): centralize audit event creation
test(billing): add collection status tests
docs(api): document pricing endpoints
chore(ci): configure container publishing
```

Use Conventional Commit principles where practical.

Do not use meaningless commit messages such as:

```text
update
fix
changes
work
final
test123
```

Each commit should leave the repository in a reasonably coherent state.

---

# 6. Pull Request Requirements

Every Pull Request must reference the relevant Issue.

Example:

```text
Closes #42
```

A Pull Request should include:

```markdown
## What changed

## Why

## Related Issue

## Database / Migration Impact

## API Impact

## Security / Permission Impact

## Audit Log Impact

## Screenshots
<!-- frontend changes -->

## Testing Performed

## Deployment Notes

## Checklist
- [ ] Tests pass
- [ ] Lint passes
- [ ] Authorization verified
- [ ] Audit events verified
- [ ] Database migrations verified
- [ ] No secrets committed
- [ ] Documentation updated
```

Do not merge broken, incomplete, or knowingly insecure code into `main`.

---

# 7. Repository Structure

The preferred root structure is:

```text
/
├── frontend/
├── backend/
├── .github/
│   ├── workflows/
│   ├── ISSUE_TEMPLATE/
│   └── PULL_REQUEST_TEMPLATE.md
├── docker/
├── docs/
├── docker-compose.yml
├── .env.example
├── .gitignore
├── AGENTS.md
├── README.md
└── LICENSE
```

Frontend-specific code belongs inside `/frontend`.

Backend-specific code belongs inside `/backend`.

Shared infrastructure, CI/CD, Docker orchestration, documentation, and repository configuration may live at the repository root where appropriate.

Do not mix frontend source code into the backend directory or vice versa.

---

# 8. Technology Stack

## Frontend

Required:

- React
- TypeScript
- Tailwind CSS
- Font Awesome

Preferred supporting tools:

- Vite
- React Router
- TanStack Query
- React Hook Form
- Zod
- Recharts or equivalent charting solution
- date-fns or equivalent lightweight date utility

Use additional dependencies only when they provide clear value.

Avoid dependency inflation.

Do not install multiple libraries that solve the same problem unless necessary.

### Frontend architecture

Prefer a domain-oriented structure such as:

```text
frontend/src/
├── app/
├── components/
│   ├── ui/
│   └── common/
├── features/
│   ├── auth/
│   ├── clients/
│   ├── billing/
│   ├── pricing/
│   ├── tasks/
│   ├── reminders/
│   ├── marketing/
│   ├── ecommerce/
│   ├── analytics/
│   ├── audit/
│   ├── users/
│   └── releases/
├── hooks/
├── lib/
├── services/
├── types/
└── utils/
```

Do not build the entire application inside a handful of giant components.

Prefer composable components.

---

# 9. Frontend UX Requirements

Roisey Else is an administrative application and must prioritize information clarity.

The interface should feel:

- modern;
- professional;
- dense enough for business use;
- easy to navigate;
- fast;
- consistent;
- responsive.

Support desktop-first workflows while remaining usable on tablets and mobile devices.

Use a consistent design system for:

- typography;
- spacing;
- colors;
- buttons;
- inputs;
- cards;
- tables;
- forms;
- badges;
- charts;
- dialogs;
- alerts;
- empty states;
- skeleton/loading states;
- success/error feedback.

Do not create one-off visual styles for every page.

Every important state must be represented:

```text
loading
empty
error
success
unauthorized
disabled
```

Destructive operations must require appropriate confirmation.

---

# 10. Backend

Required:

- Go
- PostgreSQL

Recommended backend building blocks:

- Go standard library where practical
- `chi` or another lightweight HTTP router
- `pgx`
- `sqlc` where appropriate
- structured logging
- explicit database migrations

Do not introduce a heavy framework unless there is a documented architectural reason.

Preferred backend structure:

```text
backend/
├── cmd/
│   └── api/
├── internal/
│   ├── auth/
│   ├── clients/
│   ├── billing/
│   ├── pricing/
│   ├── tasks/
│   ├── reminders/
│   ├── analytics/
│   ├── integrations/
│   ├── users/
│   ├── rbac/
│   ├── audit/
│   ├── releases/
│   ├── database/
│   ├── http/
│   └── config/
├── migrations/
├── tests/
├── Dockerfile
├── go.mod
└── go.sum
```

Separate:

- HTTP transport;
- business logic;
- database access;
- integration adapters;
- authorization;
- audit logging.

Handlers should not contain large amounts of business logic.

---

# 11. API Design

Prefer a versioned API.

Example:

```text
/api/v1/
```

Example endpoints:

```text
/api/v1/auth
/api/v1/users
/api/v1/roles
/api/v1/clients
/api/v1/clients/:id
/api/v1/clients/:id/tasks
/api/v1/clients/:id/reminders
/api/v1/clients/:id/billing
/api/v1/clients/:id/pricing
/api/v1/clients/:id/marketing
/api/v1/clients/:id/ecommerce
/api/v1/clients/:id/analytics
/api/v1/audit-logs
/api/v1/releases
```

Use consistent JSON response and error structures.

Validate every external input.

Never trust frontend validation alone.

Pagination must be implemented for potentially large collections.

Support filtering and sorting where appropriate.

---

# 12. PostgreSQL Rules

PostgreSQL is the primary application database.

Database changes must use version-controlled migrations.

Never manually modify the production database schema without a migration.

Migration naming should be deterministic and understandable.

Examples:

```text
000001_create_users.up.sql
000001_create_users.down.sql
000002_create_clients.up.sql
000002_create_clients.down.sql
```

Important data relationships must use proper:

- primary keys;
- foreign keys;
- indexes;
- unique constraints;
- check constraints where appropriate.

Avoid putting important relational business data into arbitrary JSON fields.

JSONB may be used for integration-specific or flexible provider data when justified.

All significant timestamps should be stored consistently.

Prefer UTC at the persistence/API layer.

---

# 13. Client Domain

A Client is one of the central entities in Roisey Else.

Every client must have an isolated workspace.

Client data may include:

- company name;
- legal name;
- contact people;
- email;
- phone;
- website;
- addresses;
- tax/company information;
- internal notes;
- status;
- assigned users;
- tags;
- contracts/references;
- creation/update timestamps;
- archived state.

Client workspaces should contain dedicated modules for:

```text
Overview
Tasks
Planning
Reminders
Billing
Pricing
Marketing
E-commerce
Web Analytics
Notes
Activity
Audit History
Integrations
```

Architecture should make adding future client modules straightforward.

---

# 14. Client Dashboard

Each client requires a meaningful dashboard.

The dashboard should provide a high-level operational view rather than simply displaying disconnected cards.

Potential sections include:

## Financial

- amount to collect;
- amount collected;
- outstanding amount;
- upcoming payments;
- overdue payments;
- monthly revenue;
- pricing breakdown.

## Tasks

- open tasks;
- overdue tasks;
- tasks due soon;
- completed tasks;
- responsible users.

## Marketing

Examples:

- ad spend;
- impressions;
- reach;
- clicks;
- CTR;
- CPC;
- CPM;
- conversions;
- CPA;
- ROAS.

## E-commerce

Examples:

- revenue;
- orders;
- average order value;
- conversion rate;
- refunds;
- cart metrics;
- product performance.

## Web Analytics

Examples:

- users;
- sessions;
- pageviews;
- acquisition channels;
- conversion events;
- top landing pages;
- device breakdown.

Data providers must be implemented through adapters/integrations.

Potential integrations may eventually include services such as:

- Google Analytics;
- Google Search Console;
- Google Ads;
- Meta Ads;
- Shopify;
- WooCommerce;
- other future providers.

Do not tightly couple domain models to a single external provider.

---

# 15. Integrations Architecture

External services must use an adapter/provider architecture.

Example:

```text
Integration
    |
    +-- GoogleAnalyticsProvider
    +-- GoogleAdsProvider
    +-- MetaAdsProvider
    +-- ShopifyProvider
    +-- WooCommerceProvider
```

The rest of the application should depend on internal interfaces instead of provider-specific implementations.

Store integration credentials securely.

Never expose provider secrets to the frontend.

Never commit integration credentials into Git.

Do not present mock analytics data as real customer data.

Development/demo values must be clearly identifiable as mock data.

---

# 16. Billing and Collections

Each client may have amounts that need to be collected.

The system must distinguish at minimum:

```text
pending
partially_paid
paid
overdue
cancelled
```

A billing/collection record should support data such as:

- client;
- description;
- amount;
- currency;
- due date;
- status;
- collected amount;
- payment date;
- payment method/reference;
- internal note;
- created by;
- timestamps.

Do not model collection state using only a boolean such as:

```text
is_paid = true/false
```

The financial model should support future partial payments and payment history.

Financial changes must be auditable.

---

# 17. Detailed Pricing System

Each client needs an independent pricing configuration.

The pricing model should support:

- recurring services;
- one-time services;
- custom line items;
- quantity;
- unit price;
- discounts;
- tax;
- currency;
- billing frequency;
- start/end dates;
- internal cost where appropriate;
- notes.

Example:

```text
Client Pricing
├── SEO Management
├── Meta Ads Management
├── Google Ads Management
├── Development
├── Hosting
├── Maintenance
└── Custom Service
```

Pricing records should be version-aware where practical.

Historical financial values must not silently change when current pricing is edited.

---

# 18. Task Management

Each client has its own task system.

Tasks should support:

- title;
- description;
- status;
- priority;
- assignee;
- creator;
- client;
- start date;
- due date;
- completion date;
- tags;
- comments;
- attachments where implemented;
- activity history.

Suggested statuses:

```text
backlog
todo
in_progress
blocked
review
done
cancelled
```

Suggested priorities:

```text
low
medium
high
urgent
```

Task state changes should be auditable.

---

# 19. Planning

Client planning should support longer-term work separate from immediate tasks.

Examples:

- marketing campaigns;
- releases;
- development roadmap;
- content planning;
- campaign planning;
- monthly operational plans.

Plans may contain milestones and linked tasks.

Do not overload the task model if a dedicated planning concept creates clearer domain boundaries.

---

# 20. Reminders

Users should be able to create reminders associated with clients and relevant records.

A reminder may contain:

- title;
- description;
- client;
- associated entity;
- user;
- scheduled time;
- recurrence;
- status;
- completion/dismissal information.

The architecture should be able to support future notification channels such as:

```text
in-app
email
webhook
push
```

Do not implement notification channels unless requested by the relevant Issue.

---

# 21. Users and Authentication

Roisey Else must include a secure user system.

User data should include:

- name;
- email;
- account status;
- role(s);
- last login;
- timestamps.

Authentication credentials must never be stored in plaintext.

Use secure password hashing.

Authentication/session implementation must follow secure web practices.

Prefer HTTP-only secure cookies or another explicitly secure session design.

Never store privileged long-lived authentication credentials in browser localStorage without a documented security reason.

---

# 22. Role-Based Access Control

Use RBAC.

Do not scatter role-name checks throughout the application.

Prefer permissions.

Example permissions:

```text
clients.view
clients.create
clients.update
clients.delete

billing.view
billing.create
billing.update
billing.delete

pricing.view
pricing.manage

tasks.view
tasks.create
tasks.update
tasks.delete

analytics.view

audit.view

users.view
users.manage

roles.view
roles.manage

releases.view
releases.manage
```

Roles are collections of permissions.

Example roles might include:

```text
Super Admin
Admin
Manager
Finance
Marketing
Developer
Viewer
```

These role names are examples, not hardcoded authorization logic.

Backend permission checks are mandatory.

Hiding a frontend button is NOT authorization.

---

# 23. Audit Log

Audit logging is a core requirement.

All significant write operations must create audit events.

Examples:

```text
client.created
client.updated
client.archived

billing.created
billing.updated
billing.payment_recorded

pricing.created
pricing.updated

task.created
task.updated
task.completed

user.created
user.updated
user.disabled

role.created
role.permission_changed

integration.connected
integration.disconnected

release.deployed
```

Audit events should capture where appropriate:

- event ID;
- actor user;
- action;
- target entity type;
- target entity ID;
- client ID;
- timestamp;
- request/correlation ID;
- source IP where appropriate;
- user agent where appropriate;
- before state;
- after state;
- metadata.

Sensitive credentials, passwords, tokens, or secrets must NEVER appear in audit logs.

Audit records should be append-oriented.

Normal application users must not be able to silently edit historical audit entries.

---

# 24. Activity vs Audit Logs

Do not confuse user-facing activity with security/audit history.

## Activity

Human-friendly history, for example:

```text
Ahmet completed “Prepare campaign”.
Payment marked as received.
Client contact information updated.
```

## Audit Log

Detailed system/security-oriented event data.

The application may expose both, but they serve different purposes.

---

# 25. Application Versioning

Use Semantic Versioning where practical:

```text
MAJOR.MINOR.PATCH
```

Example:

```text
1.4.2
```

Every production release should have:

- version;
- Git commit SHA;
- container image tag;
- build timestamp;
- changelog/release notes;
- deployment status.

The application UI should be able to display its currently running version.

---

# 26. Update / Release Management

Roisey Else should support controlled automatic or manual application updates.

Do NOT implement application updates by overwriting executable files inside running containers.

Container images are immutable deployment artifacts.

Preferred update model:

```text
GitHub
   ↓
main merge
   ↓
GitHub Actions
   ↓
Docker images
   ↓
GitHub Container Registry
   ↓
Deployment environment
   ↓
manual or automatic rollout
```

The application may contain a Release Center showing:

- currently installed version;
- latest available version;
- release notes;
- deployment/update status;
- update mode;
- last update check;
- last successful deployment.

Possible modes:

```text
manual
automatic
```

Automatic deployment must remain configurable and environment-aware.

Release actions themselves must be audited.

---

# 27. Docker

The entire development environment should be runnable through Docker.

The expected services should include at least:

```text
frontend
backend
postgres
```

Example:

```text
docker-compose.yml
```

Production Docker images should:

- use multi-stage builds;
- minimize image size;
- run as non-root where practical;
- contain only required runtime dependencies;
- support health checks;
- avoid embedding secrets;
- use deterministic builds.

Provide:

```text
.env.example
```

Never commit:

```text
.env
.env.production
private keys
API tokens
database passwords
```

---

# 28. GitHub Actions and Container Registry

CI/CD must use GitHub Actions.

On Pull Requests, CI should perform appropriate checks such as:

```text
frontend lint
frontend tests
frontend build

backend fmt
backend vet
backend tests
backend build

migration validation
Docker build validation
```

On merge/push to `main`, GitHub Actions should build production container images.

Images should be published to GitHub Container Registry:

```text
ghcr.io
```

Example image structure:

```text
ghcr.io/theroisey/else-frontend
ghcr.io/theroisey/else-backend
```

Images should support tags such as:

```text
latest
sha-<commit>
v1.0.0
```

Do not deploy untested code solely because a Docker image can be built.

---

# 29. CI/CD Security

GitHub Actions should use the minimum permissions required.

Prefer GitHub-provided credentials where possible.

Secrets belong in GitHub Actions Secrets or environment-specific secret management.

Never echo secrets into workflow logs.

Dependencies and third-party Actions should be selected conservatively.

Production workflows must be explicit and auditable.

---

# 30. Security Requirements

Security is mandatory.

Agents must actively consider:

- authentication;
- authorization;
- SQL injection;
- XSS;
- CSRF;
- insecure direct object references;
- privilege escalation;
- rate limiting where appropriate;
- session security;
- credential leakage;
- sensitive logs;
- insecure file uploads;
- integration token security;
- dependency vulnerabilities.

Every resource lookup must account for authorization.

Never assume that because a user knows an ID they may access that record.

Client-specific data must not leak between unauthorized users.

---

# 31. Validation

All external inputs must be validated on the backend.

Frontend validation exists for user experience.

Backend validation exists for security and data integrity.

Both are required.

Return useful validation errors without leaking internal stack traces or sensitive details.

---

# 32. Error Handling

Do not silently swallow errors.

Backend errors should:

- preserve context internally;
- be logged appropriately;
- expose safe error messages externally;
- use stable error codes where useful.

Frontend errors should provide understandable feedback.

Avoid exposing raw PostgreSQL, Go stack traces, internal paths, secrets, or infrastructure details to users.

---

# 33. Observability

Use structured logging.

Logs should make production debugging possible without leaking sensitive data.

Where practical include:

```text
request_id
user_id
client_id
route
method
status_code
duration
```

A request/correlation ID should flow through important backend operations and audit events where practical.

Provide health endpoints suitable for container orchestration.

Examples:

```text
/health
/ready
```

---

# 34. Soft Delete and Historical Data

For important business data, consider archival or soft deletion instead of immediate destructive deletion.

Examples:

- clients;
- users;
- pricing records;
- financial records.

Financial history and audit history should generally not be physically deleted through normal UI workflows.

Deletion behavior must be explicitly designed per domain.

---

# 35. Testing

No important feature is considered complete without appropriate tests.

## Frontend

Use tests for:

- important components;
- permission-sensitive UI;
- form validation;
- critical user flows;
- data transformations.

## Backend

Use tests for:

- business logic;
- authorization;
- validation;
- billing calculations;
- pricing calculations;
- task state transitions;
- API behavior;
- database-sensitive behavior.

Permission boundaries deserve explicit negative tests.

Example:

```text
Finance user CAN view billing.
Finance user CANNOT modify roles.
Viewer CAN view allowed clients.
Viewer CANNOT update a client.
```

Critical flows should eventually have end-to-end tests.

---

# 36. Database Migration Safety

Before introducing a migration, determine whether it is:

- backwards compatible;
- destructive;
- data transforming;
- potentially locking;
- reversible.

Never drop important production columns or tables casually.

For risky schema migrations, document the rollout strategy in the Issue.

---

# 37. Performance

Avoid premature optimization, but prevent obvious scalability problems.

Pay attention to:

- N+1 queries;
- missing indexes;
- unbounded result sets;
- loading huge datasets into memory;
- repeated API calls;
- dashboard over-fetching;
- unnecessary React rerenders.

Dashboard APIs may aggregate data where this materially improves performance and clarity.

Use pagination for large tables.

---

# 38. Accessibility

The admin interface should support fundamental accessibility requirements.

Use:

- semantic HTML;
- labels;
- keyboard navigation;
- visible focus states;
- sufficient contrast;
- accessible dialogs;
- meaningful button labels.

Icons alone should not make critical actions ambiguous.

---

# 39. Documentation

Architecture decisions and non-obvious behavior should be documented.

Use `/docs` for areas such as:

```text
docs/architecture.md
docs/database.md
docs/authentication.md
docs/rbac.md
docs/audit-log.md
docs/integrations.md
docs/deployment.md
docs/releases.md
```

Documentation must evolve with the code.

Do not knowingly leave documentation describing behavior that no longer exists.

---

# 40. API and Frontend Contract

Frontend and backend must have a clearly defined contract.

Do not invent frontend fields that the backend does not expose.

Do not silently change backend response structures without updating dependent frontend code.

Use shared API documentation where practical.

OpenAPI may be introduced when useful.

---

# 41. Financial Precision

Never use floating-point arithmetic for monetary business logic.

Use:

- integer minor units, or
- PostgreSQL numeric/decimal with appropriate Go handling.

Examples:

```text
100.50 TRY
100.50 USD
100.50 EUR
```

must not rely on binary floating-point calculations.

Currency must be explicitly stored.

---

# 42. Time and Timezones

Persist timestamps consistently.

Prefer UTC internally.

Convert timestamps for display according to configured user/application timezone.

Do not silently discard timezone information.

Reminders and scheduled operations require explicit timezone-aware behavior.

---

# 43. Sensitive Data

Classify and protect sensitive fields.

Examples:

- passwords;
- refresh/session tokens;
- OAuth tokens;
- integration secrets;
- payment references;
- personal contact information.

Sensitive values must not appear in:

```text
Git
frontend bundles
URLs
audit before/after payloads
debug output
application logs
GitHub Actions logs
```

unless explicitly safe and necessary.

---

# 44. Feature Flags

For large or risky capabilities, consider feature flags rather than shipping incomplete functionality as globally active.

Feature flags should not replace authorization.

---

# 45. Seed and Development Data

Development environments may use seed/demo data.

Demo data must be clearly fake.

Never copy production customer information into test fixtures or seed files.

---

# 46. Definition of Done

A task is not done just because code compiles.

A feature is complete when applicable conditions are met:

- related GitHub Issue exists;
- scope matches the Issue;
- implementation is complete;
- architecture is consistent;
- backend authorization exists;
- input validation exists;
- relevant audit events exist;
- migrations exist;
- tests exist and pass;
- lint/build passes;
- frontend loading/error/empty states exist;
- sensitive information is protected;
- documentation is updated;
- Docker build succeeds;
- CI succeeds;
- PR references the Issue;
- acceptance criteria are satisfied.

---

# 47. Agent Workflow for Every Future Prompt

For every new feature request, follow this sequence.

## Step 1 — Inspect

Inspect:

- repository state;
- current branch;
- existing source code;
- relevant migrations;
- existing APIs;
- existing Issues where accessible;
- existing documentation.

Never assume the repository is empty.

## Step 2 — Classify

Determine whether the request affects:

```text
frontend
backend
database
infrastructure
security
integrations
documentation
```

A task may affect multiple areas.

## Step 3 — Plan in GitHub Issues

Find or create the appropriate Issue.

Break large requests into manageable steps.

Define acceptance criteria.

## Step 4 — Choose Branch

Frontend work:

```text
frontend
```

Backend work:

```text
backend
```

For cross-cutting work, coordinate changes carefully across both branches while keeping `main` stable.

Do not create additional permanent branches unless explicitly requested.

## Step 5 — Implement Incrementally

Implement the smallest coherent unit first.

Do not attempt to rewrite the entire application for one feature.

## Step 6 — Verify

Run all relevant:

```text
formatters
linters
tests
builds
migration checks
Docker build checks
```

## Step 7 — Security Review

Check:

- authentication;
- authorization;
- client data isolation;
- validation;
- sensitive information;
- audit logging.

## Step 8 — Update Issue

Document completed work and unresolved items.

## Step 9 — Prepare Pull Request

Explain:

- what changed;
- why;
- how it was tested;
- migration impact;
- authorization impact;
- audit impact.

## Step 10 — Merge and Synchronize

After merge into `main`, synchronize `frontend` and `backend` as required before beginning further substantial work.

---

# 48. When Requirements Are Ambiguous

Do not invent critical business rules silently.

For small implementation details, make a reasonable maintainable assumption and document it.

For decisions affecting:

- financial calculations;
- authorization;
- data deletion;
- production deployment;
- external integrations;
- customer data ownership;
- irreversible migrations;

the decision must be explicitly represented in the relevant GitHub Issue before implementation.

---

# 49. Avoid These Patterns

Do not:

- put business logic directly inside React components;
- put all backend logic inside HTTP handlers;
- use frontend authorization as security;
- store money in float types;
- hardcode roles everywhere;
- hardcode customer IDs;
- hardcode secrets;
- expose integration tokens;
- mutate audit history;
- fake real analytics data;
- create uncontrolled schema changes;
- bypass migrations;
- deploy directly from development branches;
- build production releases from `frontend` or `backend`;
- commit directly to `main`;
- force-push branches;
- create duplicate implementations without checking existing code;
- introduce unnecessary dependencies;
- create giant files when clear modular boundaries exist.

---

# 50. Product Direction

Every architectural decision should keep in mind that Roisey Else may grow beyond the first implementation.

The platform should be capable of gradually supporting:

- many clients;
- many internal users;
- custom roles;
- external integrations;
- large audit history;
- financial reporting;
- scheduled operations;
- dashboards;
- notifications;
- multiple analytics providers;
- e-commerce providers;
- automated releases;
- additional business modules.

Build for extensibility without prematurely creating unnecessary microservices.

Start as a well-structured modular application.

Prefer a modular monolith until scale or organizational requirements provide a concrete reason to split services.

---

# 51. Core Rule

Before writing code, always ask:

> Which GitHub Issue does this solve, which domain owns it, which permissions protect it, which audit event records it, and how will we verify it?

If these questions cannot be answered, the feature is not yet sufficiently defined for production implementation.


## Obsidian Second Brain

The `notes/` directory is an Obsidian vault and must be treated as your persistent second brain for this project.

Use it to store information that may be useful in future sessions, development phases, or decisions. Whenever you encounter something worth remembering, documenting, tracking, or referencing later, write it into the `notes/` directory instead of relying only on conversation context.

### Responsibilities

- Treat `notes/` as long-term project memory.
- Record important architectural decisions, implementation details, conventions, discoveries, constraints, recurring problems, and their solutions.
- Document decisions that may affect future development.
- Keep track of unfinished ideas, technical debt, future improvements, and important follow-ups.
- Store useful domain knowledge related to Roisey Else and its customers, modules, integrations, and internal systems.
- Before making significant architectural or implementation decisions, check whether relevant notes already exist.
- Update existing notes when information changes instead of unnecessarily creating duplicates.
- If a previous decision is replaced, preserve useful historical context and clearly mark the current decision.

### Obsidian-Compatible Structure

All notes must be written in Markdown and organized in a way that works naturally with Obsidian.

Prefer:

- Clear Markdown headings.
- `[[Wiki Links]]` to connect related notes.
- Tags such as `#architecture`, `#decision`, `#todo`, `#customer`, `#integration`, or other meaningful project-specific categories.
- YAML frontmatter when metadata is useful.
- Short, focused notes instead of large unstructured files.
- Descriptive file names that make the note understandable without opening it.

Example:

```md
---
type: decision
status: active
created: 2026-10-01
tags:
  - architecture
  - customers
---

# Customer Workspace Architecture

## Decision

Each customer has an isolated workspace containing tasks, planning, reminders, analytics, pricing, and activity history.

## Reasoning

This keeps customer-specific operations centralized while allowing the global Roisey Else dashboard to aggregate data across all customers.

## Related

- [[Customer Data Model]]
- [[Task System]]
- [[Pricing System]]
- [[Analytics Architecture]]
```

### Suggested Organization

Use folders when they improve navigation. A structure similar to the following is recommended, but it may evolve with the project:

```text
notes/
├── architecture/
├── decisions/
├── features/
├── integrations/
├── customers/
├── research/
├── problems/
├── ideas/
├── todos/
└── project/
```

Do not create folders merely for the sake of categorization. Prefer a simple structure supported by meaningful links and tags.

### When to Write a Note

Create or update a note when:

- An important technical or product decision is made.
- A non-obvious implementation detail would be useful to remember later.
- A bug reveals something important about the system.
- A workaround or special constraint is introduced.
- A new convention or pattern is established.
- A future task or improvement should not be forgotten.
- Research produces information likely to be reused.
- The relationship between multiple parts of the system becomes important.
- Context would otherwise be lost between development sessions.

Routine actions and obvious implementation details do not need to become notes.

The goal is not to document everything. The goal is to preserve valuable context so that `notes/` becomes a useful, navigable, and continuously improving knowledge base for the project.

