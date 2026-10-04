# AGENTS.md — release-lab

Rules for every AI agent and human working in this repository. This is a
laboratory for the delivery pipeline that `alabasi2025/almham` will adopt; the
code under `app/` is intentionally trivial so the pipeline is the product.

## Invariants

1. **`main` is always releasable and never pushed to directly.** Every change
   arrives through one pull request that passes the single required check
   `All required checks pass`. Squash merge; the branch is deleted after.
2. **The committed version is `0.0.0` forever.** `release cut` derives the
   next version from the newest receipt tag. Never hand-edit a version.
3. **Tags are not triggers.** `rc.<N>-vX.Y.Z` is a lock pushed by `cut`, which
   then dispatches `Stable Release` on that exact ref. `vX.Y.Z` is a receipt
   created by `publish` from a green attempt. `abandoned-rc.<N>-vX.Y.Z` records
   a given-up attempt. All three are immutable (repository ruleset).
4. **One outstanding attempt of any version blocks a new cut.** Publish or
   abandon it first.
5. **The bytes that were tested are the bytes that ship.** `verify` re-hashes
   the packaged artifact against its manifest; nothing is rebuilt at publish.
6. **CI runs PR-controlled code and therefore holds no secrets.** Signing and
   publishing credentials, when added, live only in a protected environment on
   the job that needs them, never `secrets: inherit` into `ci.yml`.
7. **Skipped is not passed.** The aggregate gate requires `success`; a lane may
   be `skipped` only when the claim says so (`--skip-tests`) or the lane is
   declared `--optional` for that event.

## Workflow for a change

```
git checkout -b fix/short-description origin/main
# ... edit, npm run test:all, npm run lint ...
git commit -m "fix(scope): what and why"
git push -u origin fix/short-description
gh pr create --fill
```

## Workflow for a release (operator only)

```
npm run release -- status
npm run release -- cut --commit "$(git rev-parse origin/main)" --bump auto   # pushes rc.N, dispatches Stable Release
# wait for the run; review .release-candidates/rc.N-vX.Y.Z/notes.md
npm run release -- publish --version X.Y.Z                                   # creates receipt vX.Y.Z, publishes the draft
npm run release -- abandon --version X.Y.Z --reason "..."                   # if red
```

## Branch names

`fix/…` `feat/…` `refactor/…` `test/…` `docs/…` `ci/…` — short-lived (hours to
days). No `wip/*`, no `archive/*`, no pushed stashes, no orphan histories
(`history_check` rejects them).

## Commit messages

Conventional Commits: `type(scope): description`. `feat!:` or a
`BREAKING CHANGE:` footer marks a breaking change; `cut --bump auto` reads them.

## Agent-specific

- Agents may open pull requests and push to their own branches only.
- Agents cannot modify `.github/workflows/`; propose changes under
  `pending/workflows/` and a human moves them (GitHub enforces this).
- Agents never run `release publish`.
