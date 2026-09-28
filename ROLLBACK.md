# TurnCue rollback procedure

Use this only to recover from a bad release. Follow [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for normal verification, approval, deployment, and smoke-test gates, and [DEVELOPMENT.md](DEVELOPMENT.md) for Git conventions. This document authorizes no production action.

## 1. Identify the current and last known-good release

- Record the current production frontend's full source commit from the successful GitHub Pages deployment. Do not assume local HEAD or the latest `main` commit is what Pages serves.
- Match it to the release ledger in `DEVELOPMENT.md`, including frontend status, rules status, and the smoke-test note. Confirm the currently deployed rules separately against the recorded source version and deployment evidence; a frontend commit does not identify the live rules by itself.
- Choose a previous release with verified successful deployment and smoke testing. Resolve an existing tag to its full commit hash and inspect that revision. If no tag exists, use a verified full commit hash; do not invent a tag or treat the proposed `v0.3.0` as an existing one.
- If the ledger is incomplete, reconstruct the target from available deployment evidence and reviewed source before proceeding. A commit's age, message, or position in Git history alone is not proof it was known-good.
- Record the proposed frontend and rules targets, and check their compatibility with the data/schema and active sessions that exist now. A previously good release may not understand data written by a newer one.

## 2. Choose the rollback scope before changing either surface

| Situation | Required compatibility check |
| --- | --- |
| Frontend only | Known-good frontend works with the rules that will remain deployed and current data. |
| Rules only | Known-good rules accept the retained frontend's legitimate operations and remain safe for current data. |
| Both | The final frontend/rules pair works together; agree on an order with a compatible intermediate state. |

Neither deployment updates the other automatically. Include still-open browser versions in this decision. If no safe intermediate state is established, stop and agree on a separate coordinated recovery plan; do not improvise a deployment order.

## 3. Frontend rollback

1. Preserve and account for existing uncommitted work. Prepare a focused rollback branch from current reviewed `main`, following the branch convention and authorized scope in `DEVELOPMENT.md`.
2. Prepare a **new recovery commit** that restores the intended application source to the verified known-good state, by reverting the identified bad changes or restoring the relevant files from that commit. Review the complete runtime file set, including added/removed modules. Do not reset `main`, force-push, move old tags, or blindly replace tests, documentation, or Firebase configuration with an older tree.
3. Review the full diff against current `main`, explicitly accounting for any later accepted changes affected by the rollback. Keep the intended retained rules in the candidate tree for a frontend-only rollback; for a combined rollback, include the reviewed target rules.
4. Run `git diff --check`, the maintained `npm run test:release` checkpoint, and the local coordinated smoke test against the proposed frontend/rules pair. Do not weaken tests to make an older implementation pass; stop if the rollback checkpoint fails.
5. Obtain explicit approval before committing, merging, and pushing. Identify the new recovery commit's full hash. Push only after approval acknowledging that pushing `main` can publish the frontend.
6. Verify the GitHub Pages build/deployment succeeded and its source hash matches the **new recovery commit**, not the historical target hash. With explicit live-test approval, reload the production pages and run the production smoke test from the release checklist.

## 4. Firestore rules rollback

1. Identify `firestore.rules` from the verified known-good commit. Prepare only that reviewed rules change in the recovery candidate; inspect its diff against the currently deployed rules. Preserve current Firebase configuration and indexes.
2. Verify compatibility with the frontend that will remain or be deployed, current documents, and active sessions. Run `npm run test:rules` and the maintained release checkpoint with that exact proposed pairing. Require successful local compilation and checks before seeking deployment approval.
3. Record the reviewed rules source commit and confirm the intended production project is **`turncue-83e1a`**. Verify the reviewed checkout's `firebase.json` points to the intended rules file; do not rely on the default alias. Obtain explicit approval for any commit/merge and for the rules deployment itself. A push to `main` is a separate frontend-publication decision, even for a rules-only source change.
4. Only after approval, deploy the reviewed rules file from that checkout:

   ```powershell
   firebase deploy --only firestore:rules --project turncue-83e1a --config firebase.json
   ```

5. Confirm both compilation and release/deployment success to the intended project. Do not broaden the command to indexes, hosting, or other Firebase targets. With explicit live-test approval, run the production smoke test against the frontend actually deployed. Record the frontend as retained/unchanged when appropriate.

## 5. Data and open-tab safety

- **Source rollback does not restore or undo Firestore data.** Rules rollback changes validation of future requests; it does not repair existing documents. Neither is a substitute for data recovery.
- If corrupt, destructive, or inconsistent writes may have occurred, stop and assess the affected records and ongoing write risk before changing production. Preserve operational history; do not delete, reset, or edit data as an improvised rollback step.
- This procedure assumes no backup or restore system. Verify what recovery evidence or backups actually exist before proposing a separate, explicitly approved data-recovery action.
- Users may retain either older or newer page code in open tabs after a deployment change. Ask pilot operators to reload manager/staff pages and reload/check customer pages during the approved smoke test. Verify ticket recovery, call/completion, and cross-page synchronization; deployment success alone does not prove all tabs switched versions.

## 6. Stop conditions and completion

Stop further rollback actions and report the evidence if:

- The current deployment or known-good target commit cannot be established.
- The intended Firebase project is uncertain.
- Data corruption or destructive writes are possible.
- Frontend/rules/data compatibility, including intermediate deployment state, is unclear.
- The maintained rollback checkpoint or rules compilation fails.
- Production smoke testing reveals additional breakage.

Do not continue with another guessed target or automatic retry. Agree on the next recovery action explicitly.

After verified recovery, append a release-ledger entry/note in `DEVELOPMENT.md` recording the bad release, historical target(s), new recovery commit, actual frontend/rules deployment status and dates, and smoke-test result. Preserve the original release record. Use a new tag only if separately authorized under the existing convention; never relabel the old release as though it had not happened.
