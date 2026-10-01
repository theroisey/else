# Empty-repository bootstrap

Related Issue: [#1](https://github.com/theroisey/else/issues/1).

## Observed constraint

On 2026-10-01, GitHub reported an empty private repository, `git ls-remote --heads origin` returned no branches, and the local checkout had no commits. Its local `main` name was an unborn HEAD, not an existing branch history. There is no main commit from which frontend/backend can originate and no PR base.

`AGENTS.md` prohibits committing directly to `main`. Ordinary implementation authorization does not override this requirement. Therefore a one-time bootstrap exception must be explicitly approved, or the owner must initialize the baseline separately.

## Approved exception

The owner explicitly approved exactly one empty root commit on `main` on 2026-10-01, with no project files or secrets included, pushed as the initial PR base. The commit message is `chore: initialize repository history`. This initializes history only; it does not ship application code or bypass any future PR checks.

The approved procedure is:

1. Confirm the remote still has no commits or branches. If it has changed, inspect that history and revise this procedure.
2. Preserve local files and ensure the Git index is empty. Create the approved empty root commit on `main`; do not include baseline files.
3. Push `main` without force. Create `backend` and `frontend` from that exact baseline commit.
4. Return to `backend`. Commit only the Issue #1 baseline files, preserving the supplied `AGENTS.md` unchanged. Exclude local Obsidian settings and secrets.
5. Push `backend` and open a draft PR into `main` referencing `Closes #1`. Do not merge automatically.
6. After review and merge, synchronize both development branches with `main` using ordinary fast-forward/merge operations. Preserve all three permanent branches.

An empty `main` bootstrap is a documented exception, not a general permission to commit to production. Production behavior and publication workflows start only in their implementation Issues.

## Current status

The approved empty root commit is `6d4742d`. Its tree was verified to contain no files. `main` was pushed without force; local `frontend` and `backend` were created from that exact commit. The working branch is `backend`, which owns the Issue #1 baseline PR. The one-time exception is consumed; all subsequent changes to `main` use reviewed PRs.
