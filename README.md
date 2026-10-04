# release-lab

A working model of a modern release pipeline, built from the practices in
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent):

| Practice | Where |
|---|---|
| Single required CI check (`all-checks-pass`) | `pending/workflows/ci.yml`, `scripts/ci/required-results.mjs` |
| History check against orphan branches | `ci.yml` → `history_check` |
| Version derived from receipt tags; source stays `0.0.0` | `scripts/releases/versioning.mjs`, `scripts/build.mjs` |
| Attempt ref `rc.N-vX.Y.Z` as an atomic lock | `scripts/releases/release.mjs` → `cut` |
| Claim bound in the annotated tag; admission re-reads it | `scripts/releases/claim.mjs`, `release.mjs` → `admit` |
| Tags are never triggers; `cut` dispatches the workflow | `release.mjs`, `pending/workflows/stable-release.yml` |
| Same bytes tested and shipped; verify re-hashes | `stable-release.yml` → `build` / `verify` |
| Receipt tag `vX.Y.Z` created at publish, not at green | `release.mjs` → `publish` |
| Abandon marker, attempt ref kept, version not spent | `release.mjs` → `abandon` |
| Daily canary as prerelease, pruned after 14 days | `pending/workflows/canary.yml` |
| CI secret-free; release signing isolated | workflow comments; see AGENTS.md |
| Action pins by commit SHA | all workflows |
| Changelog generated from Conventional Commits | `scripts/releases/changelog.mjs` |

## Try it

```
npm run test:all && npm run lint && npm run build
npm run release -- status
npm run release -- cut --commit "$(git rev-parse origin/main)" --dry-run
```

## Why `pending/workflows/`?

GitHub refuses workflow changes from GitHub Apps without the `workflows`
permission. The agent that scaffolded this repo therefore placed the three
workflows under `pending/workflows/`; a human moves them into
`.github/workflows/` (see `docs/SETUP.md`). This is the same boundary
`CODEOWNERS` declares: what CI executes is always reviewed by a person.
