# TurnCue release checklist

Manual release gates for the GitHub Pages frontend and separately deployed Firestore rules. Follow [DEVELOPMENT.md](DEVELOPMENT.md); checking a box does not grant permission to commit, merge, push, tag, deploy, or write live data.

## 1. Pre-release gate

- [ ] Review the working tree, including untracked files. Account for every intended file; exclude unrelated work, secrets, downloaded tools, logs, and unexpected artifacts.
- [ ] Run `git diff --check` and `npm run test:release`; require a passing maintained checkpoint. Stop at the first meaningful failure and diagnose it before proceeding.
- [ ] Pass the coordinated manager/staff/customer manual test described in [README.md](README.md) against the local emulator before publication. Record the result; this does not replace the production smoke test below.
- [ ] Identify the exact release revision. If it is not committed yet, complete the approved Git gate below and record its full commit hash before either deployment. Confirm the deployed files will come from that revision, not uncommitted edits.
- [ ] Review frontend/rules compatibility and agree on deployment order, including behavior during the interval between deployments. Do not assume the two surfaces update together.

## 2. Git gate

- [ ] Review the staged diff (`git diff --cached`) and intended file list; require `git diff --cached --check` to pass.
- [ ] Obtain explicit approval before committing and, if applicable, merging into `main`. Record the final release commit hash after those approved operations; reverify affected changes if the reviewed scope changed.
- [ ] Obtain explicit push approval that acknowledges **pushing `main` automatically triggers frontend publication through GitHub Pages**. Confirm the outgoing commits contain only reviewed work.

## 3. Frontend deployment verification

- [ ] After the approved push, verify the GitHub Pages build/deployment completed successfully; a successful push alone is insufficient.
- [ ] Confirm the deployment's source commit matches the approved full release commit hash. Record the deployment result and date.
- [ ] Open the published customer, manager, and staff pages. Reload existing operational tabs and check fresh tabs; account for open-tab/cached-version skew during the smoke test.

## 4. Firestore rules deployment

- [ ] Confirm the intended production project is **`turncue-83e1a`**, the rules file is the approved release's `firestore.rules`, and `firebase.json` points to that file. Do not rely on the default alias alone.
- [ ] Obtain explicit rules-deployment approval. If the accepted deployed rules already match the release source, record `unchanged from <release/commit>` instead of redeploying unnecessarily.
- [ ] When a deployment is needed, use the rules-only command from the reviewed checkout:

  ```powershell
  firebase deploy --only firestore:rules --project turncue-83e1a --config firebase.json
  ```

- [ ] Confirm rules compilation succeeds and the CLI reports successful rules release/deployment to the intended project. Compilation alone is not deployment success. Record the result and date.
- [ ] Do not replace the command with an unscoped `firebase deploy` or `--only firestore`; do not include indexes, hosting, or other Firebase targets in this approval.

## 5. Production smoke test

Run only with explicit approval for the live test and its operational writes. Use the published pages and agreed pilot test participants; preserve operational history.

- [ ] Manager loads the intended queue/session without initialization or listener errors.
- [ ] Staff confirms their Staff ID and starts a shift at an available window.
- [ ] Customer joins and receives a ticket; Call Next shows the correct window, and completion succeeds.
- [ ] Manager, staff, and customer remain synchronized throughout the call/completion cycle.
- [ ] If relevant to the release, close/reopen an unassigned window and verify expected availability and assignment guards.
- [ ] If inactivity behavior changed, spot-check confirmation and expired-check auto-pause with retained ownership, plus the occupied-window/empty-queue safeguards. Keep a manager/staff page open: this remains a best-effort browser safeguard, not a server watchdog.
- [ ] Record pass/fail, test date, and any limitations. Do not mark the release complete while a major flow or compatibility failure is unresolved.

## 6. Release record

- [ ] Append the release row to the ledger in [DEVELOPMENT.md](DEVELOPMENT.md): tag (or `pending` until authorized and created), full commit hash, release date/timezone, frontend deployment status, and rules deployment status.
- [ ] Add the production smoke-test result/date and any limitations as an adjacent note. Distinguish deployed-and-verified, unchanged, and partial/pending statuses.
- [ ] Create/publish an annotated release tag only with explicit authorization, after applicable deployments and smoke checks pass, following the tag convention in `DEVELOPMENT.md`.

## 7. Rollback consideration triggers

Stop further release actions and flag a rollback decision if any of these appears:

- [ ] Production pages fail to load or initialize.
- [ ] Permission failures reveal frontend/rules incompatibility.
- [ ] Duplicate/inconsistent assignments or other evidence creates a data-corruption risk.
- [ ] A major manager/staff/customer join, shift, call, completion, or synchronization flow fails.

Follow [ROLLBACK.md](ROLLBACK.md) for recovery after a bad release; these triggers do not authorize a rollback.

## 8. Safety reminders

- Frontend and rules are separate deployment surfaces; verify both against the release record.
- Rolling back source does **not** restore Firestore data.
- `firestore.indexes.json` is a partial record, not a complete deployed-index inventory. Do not use this release to remove or synchronize indexes.
- Old open tabs can run older code even after successful publication; include reload/version-skew checks in production verification.
