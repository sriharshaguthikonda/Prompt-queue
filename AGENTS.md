# AGENTS.md

## Purpose
This file defines baseline engineering workflow rules for contributors and coding agents in this repository.

## Open Work
See [TODO.md](TODO.md) for prioritized issues.
Live query: `gh issue list --repo sriharshaguthikonda/Prompt-queue --state open`

## Repo Intel
<!-- BEGIN MANAGED REPO-INTEL -->
- If `.repo-intel/manifest.json` exists, read it first.
- For file-specific context, use `repo-map context slice --repo <repo> --path <file> --json`.
- If `repo-map` is missing from PATH, use `C:\Users\deletable\.local\bin\repo-map.cmd` or `C:\AI\Repo_maps\.venv\Scripts\python.exe -m repo_maps.cli`.
- Do not load whole maps by default.
<!-- END MANAGED REPO-INTEL -->

## Daily Git Workflow
1. Start from a clean state: `git status`.
2. Sync local refs: `git fetch --all --prune`.
3. Update `main` before starting work:
   - `git checkout main`
   - `git pull --ff-only origin main`
4. Create or switch to a feature branch from updated `main`.

## Separate Worktree Workflow
- When the user is actively working in one branch, do implementation work in a separate Git worktree by default.
- Preferred pattern:
  - Create: `git worktree add ..\\Prompt-queue-<branch-name> <branch-name>`
  - Or create new branch + worktree: `git worktree add -b <new-branch> ..\\Prompt-queue-<new-branch> main`
- Keep one branch per worktree; do not reuse a worktree for unrelated tasks.
- Run commits and pushes from the worktree where the branch is checked out.
- After merge/cleanup, remove unused worktrees:
  - `git worktree remove ..\\Prompt-queue-<branch-name>`
- If there are uncommitted changes in the current tree, either commit/stash first or create a patch before switching to a new worktree.

## Commit Rules
- Commit often in small, reviewable increments.
- Each commit should represent one logical change.
- Use clear commit messages in imperative mood, for example:
  - `Fix content script reconnect logic`
  - `Add watched element gate toggle`
- Avoid mixing refactors, feature changes, and unrelated fixes in one commit.

## Push Rules
- Push your branch after meaningful progress, not only at the end.
- Keep remote branch current to avoid large drift:
  - `git push origin <branch>`
- Do not push broken code intentionally.
- Do not force-push shared branches unless explicitly coordinated.

## Keep Branch Up To Date
- Before opening a PR and before major merges, sync with latest `main`.
- Preferred:
  - `git fetch origin`
  - `git rebase origin/main`
- Resolve conflicts carefully and rerun validation steps.

## Validation Before Commit
- Run relevant checks/tests for touched files.
- At minimum:
  - syntax checks for changed JS files
  - targeted manual verification for extension behavior
- If tests are skipped, document why in PR notes.

## Code Safety Rules
- Never commit secrets, tokens, credentials, or local machine paths unless required and reviewed.
- Never use destructive Git commands on shared work without explicit approval.
- Keep changes scoped to the task; do not rewrite unrelated files.
- Keep generic scripts and UI files modular. Avoid growing catch-all files; put new reusable behavior in focused modules and wire it through the existing owner.

## PR Readiness Checklist
- Branch is rebased or merged with latest `main`.
- Commits are clean and logically grouped.
- Tests/checks pass (or skips are documented).
- PR description includes:
  - what changed
  - why it changed
  - how it was tested
  - risk/rollback notes

## Communication Norms
- Raise blockers early.
- Call out assumptions explicitly.
- Prefer concrete logs and reproducible steps when reporting issues.
