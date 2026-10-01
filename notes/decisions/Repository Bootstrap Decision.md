---
type: decision
status: approved-and-executed
created: 2026-10-01
tags:
  - decision
  - devops
  - todo
---

# Repository Bootstrap Decision

## Constraint

The repository has no main commit, so GitHub cannot accept a normal development PR against main. AGENTS.md prohibits direct main commits and requires frontend/backend to originate from main.

## Approved resolution

The owner approved a one-time exception on 2026-10-01 for an empty root main commit, with no files, followed by normal frontend/backend branches and a baseline backend PR. All application and baseline files stay out of the empty commit. No automatic merge or deployment is authorized.

The detailed procedure is in [repository-bootstrap.md](../../docs/repository-bootstrap.md). Approval came from the owner's explicit response to the exception request. The exception applies to exactly this initialization; ordinary development or sandbox approval does not permit another direct main commit.

## Current state

Empty root commit `6d4742d` was created and its empty tree verified, then main was pushed without force. Local frontend/backend were created from that exact main baseline. Baseline files are prepared on backend for the Issue #1 PR. The bootstrap exception is consumed.

## Related

- [[Repository Audit]]
- [[Issue 1 PR Draft]]
- [Issue #1](https://github.com/theroisey/else/issues/1)
