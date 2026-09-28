# TurnCue development workflow

Keep work in focused slices. Follow [AGENTS.md](AGENTS.md) and use the maintained checks in [tests/README.md](tests/README.md). This convention does not authorize any Git mutation or deployment.

Navigation: [README](README.md) · [Architecture](docs/ARCHITECTURE.md) · [Release checklist](RELEASE_CHECKLIST.md) · [Rollback](ROLLBACK.md) · [Test guide](tests/README.md).

## Branches

- `main` contains reviewed, production-ready code. GitHub Pages publishes from `main`, so an approved push automatically triggers frontend publication. Verify the deployment result separately. The release history below identifies what has actually been released; a local commit alone is not a deployment.
- Start each new slice from current, reviewed `main`, with its remote state checked before branching. Account for any existing uncommitted work first: preserve it and agree on its disposition rather than resetting, discarding, or mixing it into another slice.
- Use one short-lived branch per focused slice: `codex/<kind>/<short-name>`. Use lowercase hyphenated names; choose `feat` for product features, `fix` for defects, or `eng` for engineering/documentation work. Examples: `codex/feat/customer-cue`, `codex/fix/ticket-recovery`, `codex/eng/git-convention`.
- Keep experimental work off `main`. No permanent development/release branches or GitFlow are needed.

## Review and merge

1. Finish the focused change and inspect its complete diff, including new files. Preserve accepted behavior and avoid unrelated cleanup.
2. Run the relevant focused verification before merge. Documentation-only changes need `git diff --check`; select product checks using the test README. Stop on the first meaningful failure, diagnose its source, and rerun only the affected check after a surgical fix.
3. Present the diff, verification results, and remaining limitations for explicit review. A local diff is sufficient for the solo workflow; a pull request is optional.
4. Obtain explicit approval before committing, merging into `main`, pushing, tagging, or deploying. Approval of an implementation or test result does not itself authorize these actions. An approval may cover several actions only when it explicitly names them. Because a push to `main` automatically triggers Pages, its approval must acknowledge frontend publication.
5. Merge only the reviewed scope. If changes or conflict resolution alter that scope, review and verify the affected work again before merging. Do not force-push or rewrite released history as routine workflow.

## Release tags

Use annotated tags in the form `v<major>.<minor>.<patch>`.

- Reserve `v0.3.0` as the proposed Batch 3 release tag; it has **not** been created by this documentation task. A later retrospective tag must identify the verified Batch 3 release commit, not whichever commit happens to be HEAD then.
- While the product is pre-1.0, use the next minor version for a deliberate product batch (normally `v0.4.0` for Batch 4) and the next patch for an intervening released fix or engineering update (for example, `v0.3.1`). Not every slice needs a release tag. Agree on the version before release; do not infer it automatically from branch names.
- Create the tag only after explicit authorization and verification of the applicable frontend/rules deployment and smoke checks. It points to the exact reviewed commit on `main` whose source represents that accepted release, never to uncommitted work or an unmerged branch.
- The annotation names the release, actual release date, and frontend/rules status. Frontend and rules deploy independently: a tag deploys neither and does not prove that they are synchronized. Record rules as unchanged when the accepted deployed rules already match the tagged source; do not imply they were newly deployed.
- If deployed frontend or rules do not match the intended release source, resolve and verify that mismatch before calling the release complete and tagging it. Do not move or reuse a published release tag; use a new version for a subsequent correction. Publishing a tag also requires explicit push approval.

## Release history

Keep a small append-only release ledger **in this section** for now; no separate release system or file is needed. Add a row when a release is verified, then record its actual tag when authorized and created. Use `pending` until that tag exists. A later documentation commit may record an earlier release's immutable commit hash.

| Release tag | Full release commit hash | Release date (YYYY-MM-DD, timezone) | Frontend deployment status | Rules deployment status |
| --- | --- | --- | --- | --- |

For each component, record `deployed and verified` with its deployment date, or `unchanged from <release/commit>` after confirming it matches the release source. Record partial/pending deployment explicitly; never mark it complete merely because code was merged. For a retrospective entry, distinguish the actual release date from the later tag-creation date in a short note. If a historical value cannot be verified, mark it unknown rather than inventing it.

Batch 3 is reported released and production smoke tested at `b3b08809a2b8f4e0ff3d1fac672c8b63683ec688`. This ledger is intentionally incomplete until deployment dates/status evidence and the smoke-test record are recorded through review. No historical tag or release date is implied; `v0.3.0` remains proposed. Do not infer missing evidence from the commit date.

The accepted engineering foundation is still local and uncommitted. Include the consistent, currently untracked `AGENTS.md` in the eventual explicitly approved foundation Git checkpoint. Review and approve that checkpoint separately; a reviewed commit records the work but does not publish it. An approved push to `main` triggers Pages, whose success must then be verified. Rules deployment, if needed, requires separate approval and verification under the release checklist.
