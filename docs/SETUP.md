# Setup — the three steps a human must do

Everything else in this repository was created and verified by the agent. These
steps need a human because GitHub reserves them for one.

## 1. Move the workflows (one time, from the browser)

GitHub refuses workflow files pushed by a GitHub App. For each of the three
files under `pending/workflows/`:

1. Open the file on GitHub → **Raw** → copy all.
2. Repository → **Add file → Create new file**.
3. Name it `.github/workflows/<same-name>.yml`, paste, **Commit changes…**
   → *Create a new branch* → open the pull request.
4. The PR will show `All required checks pass` once `ci.yml` is in place.
   Merge it (squash).

Order does not matter; do all three in one PR if you prefer. After the merge,
delete `pending/workflows/` in a follow-up PR (the contract tests read from
`.github/workflows/` automatically once it exists).

## 2. Branch protection — already applied by the agent

The repository is public, so protection is free and was applied via the API:

| Rule | Value |
|---|---|
| Pull request required | yes, 1 approval, code-owner review, stale reviews dismissed |
| Required status check | `All required checks pass` (strict) |
| Linear history / conversation resolution | yes |
| Force-push / deletion | blocked |
| Applies to admins | yes |

Tag ruleset "Release refs are immutable": `v*`, `rc.*`, `abandoned-rc.*` — no
update, no delete, no non-fast-forward, no bypass.

> Until `ci.yml` exists on `main`, no PR can produce the required check. The
> very first PR (the one that adds the workflows) therefore needs the status
> check requirement lifted for a minute and restored right after:
>
> ```
> gh api -X DELETE repos/alabasi2025/release-lab/branches/main/protection/required_status_checks
> # merge the workflows PR
> gh api -X PATCH repos/alabasi2025/release-lab/branches/main/protection/required_status_checks \
>   -F strict=true -f 'contexts[]=All required checks pass'
> ```

## 3. First release — the demo

```
git fetch origin && git checkout main && git pull
npm run release -- status                     # published: none
npm run release -- cut --commit "$(git rev-parse origin/main)" --bump minor
#   → pushes rc.1-v0.1.0, dispatches Stable Release
gh run watch                                  # admit → ci → build → verify → draft → acceptance
npm run release -- publish --version 0.1.0    # receipt v0.1.0, draft → published release
npm run release -- status                     # published: v0.1.0
```

If the run goes red: fix on a branch → PR → merge → `release abandon --version 0.1.0` →
`release cut` again (it will be `rc.2-v0.1.0`).

## What to measure in the lab

- Minutes consumed per PR and per stable release (Actions → Usage). Public
  repositories are free; this tells you what `almham` (private) would cost on
  GitHub-hosted runners.
- Time from `cut` to `publish`.
- Whether `history_check`, lock contention, and `abandon` behave as the tests
  describe when driven by real people.
