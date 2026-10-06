---
name: Engineering task
about: Define a focused implementation, defect, or infrastructure change before coding.
title: ""
labels: ""
assignees: ""
---

## Summary

Describe the concrete change or defect in one paragraph.

## Context

Describe existing behavior, relevant repository evidence, and related decisions.

## Goal

State the observable result.

## Scope

Define the smallest coherent slice and its owning domains.

## Functional Requirements

- Describe required user or system behavior.

## Technical Requirements

Identify existing abstractions, domain ownership, validation, pagination, and contracts. Work on `main` only and record significant decisions before implementation.

## Database Changes

Describe schema/data changes, constraints, migration compatibility, locking, rollback, and historical integrity. Write “None” when not applicable.

## API Changes

Define endpoints, request/response/error contracts, and compatibility. Write “None” when not applicable.

## Frontend Changes

Describe screens and reused components. Include loading, empty, error, success, unauthorized, disabled, responsive, and accessible behavior where applicable.

## Authorization Requirements

Specify permissions and client scope for every read and write. Document negative cases, secret handling, and security-sensitive decisions.

## Audit Log Requirements

Specify events, safe snapshots, transaction behavior, and sensitive fields to exclude. Distinguish audit records from user-facing activity.

## Testing Requirements

List relevant unit, integration, negative-permission, migration, frontend, container, and CI checks. Explain non-applicable checks.

## Acceptance Criteria

- [ ] Observable scope is implemented and verified.
- [ ] Relevant validation, authorization, audit, and migration checks pass.
- [ ] Relevant lint, typecheck, tests, build, Docker, and CI checks pass.
- [ ] Documentation and relevant concise maintenance notes are updated.
- [ ] No secrets or production customer fixtures are committed.
- [ ] Change commits reference this Issue.

## Dependencies

Link prerequisite Issues and identify their required deliverables.

## Out of Scope

Identify excluded behavior and follow-up Issues.
