# TurnCue development workflow

Keep work in focused slices. Follow [AGENTS.md](AGENTS.md) and use the maintained checks in [tests/README.md](tests/README.md). This convention does not authorize any Git mutation or deployment.

Navigation: [README](README.md) · [Architecture](docs/ARCHITECTURE.md) · [Release checklist](RELEASE_CHECKLIST.md) · [Rollback](ROLLBACK.md) · [Test guide](tests/README.md).

## Current Checkpoint / Batch 4

October 5, 2026. Batch 4 was operationally released on 2026-10-17 America/Los_Angeles. The release record is in Release history below.

Batch 4 established resilient customer, staff, and manager workflows around ticket recovery, connectivity, uncertain actions, and window presence.

All planned 4E and 4F pilot slices through 4F-4C were implemented and validated with focused browser/integration tests.

Completed:

- 4E-1 Assisted issuance
- 4E-2 Customer ticket/code recovery
- 4E-3 Staff/manager ticket lookup
- 4F-1 Customer connectivity awareness
- 4F-2 Durable JOIN reconciliation
- 4F-3A Staff/manager freshness
- 4F-3B Staff/manager action reconciliation
- 4F-4A Presence foundation
- 4F-4B ETA/fairness presence integration
- 4F-4C Presence UX/reconnect/reopen

Batch 4 pilot status:

**COMPLETE FOR PILOT SCOPE**

This does not mean production SaaS readiness or feature completeness.

The current pilot model allows presence loss to affect ETA/fairness capacity without automatically changing operational state or customer lifecycle.

4F-4D, long-term window presence/ownership policy, remains intentionally deferred pending a separate product decision.

Current pilot limitations:

- Presence expiry is observer-driven.
- The five-minute grace period is a pilot policy.
- Active legacy assignments with no presence evidence retain existing capacity behavior.
- Presence is not authentication.
- Operational decisions remain human-controlled.
- Previous-session recovery requires an explicit session-bearing mechanism; global historical ticket search is not supported.
- There is no automatic window recovery or reassignment.
- Persistent offline operation is not implemented.
- Browser ownership is not implemented.

Protected throughout Batch 4:

- ticket lifecycle
- ticket assignments
- callAttemptId
- calledAt
- FIFO / queueOrder
- fairness allowances
- service samples
- operational history
- paired atomic actions
- shift ownership
- window ownership
- assisted issuance
- customer recovery
- JOIN reconciliation
- Batch 3 inactivity behavior

Security boundary:

The current system remains a trusted-pilot implementation. Production authentication and authorization are not yet implemented as a complete security boundary.

Batch 5 direction:

Batch 5 should begin with a pilot-readiness/product review rather than immediately adding another engineering feature.

The primary question is whether a real manager, staff member, and customer can use TurnCue successfully without the developer needing to explain the system.

Initial Batch 5 review areas:

- manager onboarding/setup
- staff onboarding
- customer first-use experience
- queue/session creation and opening
- operational states and messaging
- pilot reset/end-of-session workflow
- documentation/help
- demo/presentation flow
- pilot checklist
- remaining production blockers

## Active handoff — staff action reconciliation (2026-10-17)

Fresh Ava session starts here. The narrow `confirm_present` reconciliation slice is verified. Do not change that implementation unless new evidence requires it. The exact `staff_need_more_time` mixed first-pass view now has its own deferred second-read proof. Do not fold it into `promoteConfirmedPresent`. The opposite mixed view stays fail-closed.

### Verified root cause

`confirm_present` commits `status` `called` → `in_progress` and `confirmedPresentAt` null → server timestamp, and does not update the window (`turncue.js` `transitionTicket`). `runTransaction` resolves when the Commit RPC succeeds. Reconciliation then runs because the client lost that acknowledgement. It does not replay the mutation.

`reconcileAction` reads with `getDocFromServer`, then reads every observed document again. Outcome text is computed from the first read. If any second signature differs, it fail-closes with `State changed while checking. Check current state again.` (`operation-blocked`). The page then shows `Unable to confirm current state. No action was replayed.`

Captured failure, `.test-output/browser-1792277428709-staff-action-reconciliation-browser.log`, immediately after the completion PASS, at THEY'RE HERE lost-ack (current test line 185):

- Only document: `sessions/KTQlzDEPg0FDWxTZu0B9/entries/ticket-3`
- Only field differences: `status` `called` → `in_progress`; `confirmedPresentAt` null → Firestore timestamp (`seconds` 1792277444, `nanoseconds` 307000000)
- Unchanged on that ticket: `callAttemptId` `Jj4x0NZFwYOnLlne60d1`, `calledWindowId`, `calledByShiftId`, `calledByStaffId`, `calledAt`, `ticketLabel` A103, and every other field
- No window, shift, staff, queue, or session document differed
- Both differing fields are the `confirm_present` lifecycle write. They are not reporting metadata and not presence or capacity fields

Cause class: product reconciliation interacting with the pinned client SDK. Rules hash on that run: SHA256 `7092dd618bd9`. SDK `12.19.0` in `.test-tools/firebase-firestore.js`.

Fact, from the pinned SDK inspected in the prior session: `getDocFromServer` is a one-shot snapshot listener (`source: "server"`), not an independent BatchGet. It resolves on the first snapshot that is not `fromCache`. The staff page already has listeners on that client. With an active listener, that snapshot can still be the pre-commit view. Firebase maintainer comment on `firebase-js-sdk#6915` (2023-02-22) reproduced this against production Firestore: Firestore does not guarantee read-your-writes between a transaction and a later non-transaction get while a listener is active. This is not an emulator-only store bug. TurnCue has not reproduced it against production.

Inference: the first reconciliation listen still held the pre-commit watch view; the second listen ran after the watch applied the commit. A second client writing `confirm_present` is unlikely: the test clicks THEY'RE HERE once, and the changed fields match that transaction.

### Approved behavior

When reconciliation can prove that the exact `confirm_present` action became authoritative between the two reads, TurnCue recognizes the action as recorded. Proof requires all of the following:

- `context.action` is `confirm_present`
- same call attempt as `context.callAttemptId` on both reads
- same assignment on both reads (`calledWindowId`, `calledByShiftId`, `calledByStaffId` match the captured context and each other)
- first status is the captured `preStatus` `called`; second status is `in_progress`
- `confirmedPresentAt` goes null → timestamp
- no other ticket field differs
- every other observed document’s second signature matches its first

Any other mismatch still fail-closes. The mutation is never replayed. The separate Ticket snapshots disagree case is not part of this `confirm_present` exception. Its later `staff_need_more_time` proof is recorded below.

### Exact proposed implementation scope

Edit only the stability-mismatch branch of `reconcileAction` in `turncue.js` (current fail is lines 615–616). Keep the two reads and the signature check.

When the check fails, retain the second snapshots long enough to apply the predicate above. On a match, replace the first ticket object with the second read before computing the outcome. If `assigned` is that same document, replace `assigned` too. Staff and manager `apply` render `state.assigned` / `state.original`; the returned objects must be the post-commit ticket. The existing outcome line then yields `{ticketLabel}: IN_PROGRESS is recorded. No action was repeated.`

On any other difference, keep `fail("State changed while checking. Check current state again.")`.

Do not call `transitionTicket`. Do not change `actionReconciliation`, signature ignores, assertions, retries, timeouts, Firestore rules, or the test diagnostics.

### Safety invariants that must remain

- The two reads are not an atomic snapshot.
- Outcome comes from the first read unless the second read matches, or this `confirm_present` predicate matches and the outcome is taken from the second ticket snapshot.
- Unexplained or unrelated lifecycle differences stay fail-closed. That includes any other status (`opted_out`, `no_show`, `waiting`, or another transition), a new `callAttemptId`, an assignment change, any extra ticket-field change, and any window, shift, staff, queue, or session change.
- The mutation is never replayed.
- `lastPresenceAt` and `lastPresenceBrowserId` remain the only signature ignores.
- This exception covers `confirm_present` only.

### Files likely affected

- `turncue.js`: `reconcileAction` stability branch only.
- `tests/staff-action-reconciliation-browser.mjs`: leave the diagnostic wrapper, stability DIFF recorder, and ticket-snapshot DIFF recorder in place. Change this file only if a later approval adds a predicate lock. Do not weaken existing assertions.

Leave `join-entry.js`, `tests/concurrency.mjs`, `firestore.rules`, `staff.html`, and `business.html` unchanged for this slice.

### Focused tests required

After the edit, run only:

`npm run test:browser -- staff-action-reconciliation-browser`

A pass is not proof. The race is intermittent. If the log has no `confirm_present` stability DIFF, the new branch was not exercised. Do not add retries or timeouts to force it.

`concurrency call` and `inactivity-release` later passed in the full release suite recorded below.

### Unresolved Ticket snapshots disagree issue

One focused run, `.test-output/browser-1792276846237-staff-action-reconciliation-browser.log`, failed after the presence PASS with `operation-blocked` / `Ticket snapshots disagree.` The stack then was `staff-action-reconciliation-browser.mjs:184`. That is the STAFF NEED MORE TIME lost-ack step. The throw is in the first-pass pointer check, before the stability second-read, so that log has no field diff. Do not treat this as the `confirm_present` visibility gap.

A later test-only script forced the read-order mix on one direct `captureAction` + `reconcileAction` after the real lost-ack had committed. The first entry read was the committed ticket overlaid back to `in_progress` and the saved `callAttemptId`. The window and shift stayed real post-commit reads. Focused run `.test-output/browser-1792294309094-staff-action-reconciliation-browser.log`, project `demo-tc-action-check-50db1c3f`, rules SHA256 `7092dd618bd9`. The original-ticket guard threw. Payload: `kind: "original-ticket"`, mismatches `id` and `callAttemptId`, window `jnlbV5AWeR5UuCI1wLdf` with `currentEntryId` null and `currentCallAttemptId` null, original `ticket-7` status `in_progress` callAttemptId `xjX3YBbfRtmsxA3v7Blm`, assigned null. The server ticket, window, and shift were unchanged. The opposite mixed-read case is not scripted.

The approved deferred proof is now implemented in `reconcileAction` only. The pointer guard still fail-closes by default. Deferral applies only when `staff_need_more_time` has this exact mixed first pass. Acceptance uses the existing second reads and rebinds only after that proof. The mutation is not replayed. `promoteConfirmedPresent` is unchanged.

### Current uncommitted state

Branch `main` at `e40d280`. The Batch 4 foundation is still local and uncommitted. `turncue.js` already contains the larger uncommitted Batch 4 diff versus HEAD, including the verified `confirm_present` predicate and the verified `staff_need_more_time` deferred proof. Every other mismatch still fail-closes.

Session edits still in the working tree:

- `tests/concurrency.mjs`: JOIN mode seeds `queues/main-queue` with `{ businessId, locationId, currentSessionId }`, the same shape the CALL branch already seeds (line 177). Focused JOIN passed: `.test-output/concurrency-1792275040006-concurrency.log`, project `demo-tc-concurrency-join-c6cfa0ff`, A101–A106, 0 permission errors. The `join-entry.js` current-session guard was not part of that edit.
- `tests/staff-action-reconciliation-browser.mjs` is untracked and holds the test-only diagnostics described above. An earlier full `test:release` stopped on this test (`.test-output/release-1792275359467-staff-action-reconciliation-browser.log`, `State changed while checking`, after the completion PASS). The later full suite passed; see the release result below.

Do not commit, push, deploy, or publish. Do not remove the diagnostic. Approval of this behavior does not authorize those actions.

### Verified result (2026-10-17)

This slice is verified. `promoteConfirmedPresent` remains the production decision. The deterministic test instruments `getDocFromServer` only while its `reconcileAction` wrapper sets `reconcileViewActive`, then clears that script. It does not copy the predicate.

Focused run: `npm run test:browser -- staff-action-reconciliation-browser`. Result: PASS. Log: `.test-output/browser-1792293771866-staff-action-reconciliation-browser.log`. Rules SHA256 `7092dd618bd9`.

- The positive THEY'RE HERE lost-ack exercised the real `promoteConfirmedPresent` predicate. Entry `sessions/uOjjt5sFrQsGAQxrkWnW/entries/ticket-3`.
- The only accepted differences were `status` `called` → `in_progress` and `confirmedPresentAt` null → timestamp (`seconds` 1792293782, `nanoseconds` 783000000). `callAttemptId` stayed `ZoJhfBtCmmdHS3Uck3Z9`.
- The authoritative outcome was `A103: IN_PROGRESS is recorded. No action was repeated.` The mutation was not replayed.
- An altered returned `callAttemptId` (`reconcile-negative-attempt`) deterministically failed closed with `operation-blocked` / `State changed while checking. Check current state again.`
- The real server ticket stayed `in_progress` with `ZoJhfBtCmmdHS3Uck3Z9` and its original `calledAt`.
- The remaining focused reconciliation scenarios passed.

Do not change the `confirm_present` implementation unless new evidence requires it. The full release suite has since passed. Do not commit, push, deploy, or publish.

### Verified staff_need_more_time result (2026-10-17)

Focused run: `npm run test:browser -- staff-action-reconciliation-browser`. Result: PASS. Log: `.test-output/browser-1792295674614-staff-action-reconciliation-browser.log`. Project `demo-tc-action-check-a5912bda`. Rules SHA256 `7092dd618bd9`.

- The positive deferred-pointer branch ran. First ticket view: `in_progress`, callAttemptId `fCjSfCFiyku9EYGuo3Zc`, `staffNeedMoreTimeAt` null, `queueOrder` null, called window `HPLg1mlJ78dXZ4Runhgm`, shift `MlbdZTqJSyg2fKc6AH4Y`, staff `XSilpaYNzSeVHQa27BKm`. Window and shift were already cleared and `active`.
- The second read proved `waiting`, callAttemptId null, finite `queueOrder` `107`, the same `calledWindowId`, and `staffNeedMoreTimeAt` timestamp (`seconds` 1792295692, `nanoseconds` 127000000). No other observed document differed.
- The authoritative outcome was `A107: staff Need More Time is recorded; current state is WAITING. No reposition was repeated.`
- A returned second ticket whose `calledWindowId` was `foreign-window` failed closed with `Ticket snapshots disagree.` The first-pass pointer payload stayed null. The stored ticket kept `HPLg1mlJ78dXZ4Runhgm`. The server ticket, window, and shift stayed unchanged in both cases.
- The captured pre-action `queueOrder` was null. The proof accepted the committed finite value and did not require a numerical change. The remaining focused scenarios passed.

### Release suite result (2026-10-17)

`npm.cmd run test:release` passed all 35 tests. Emulator log: `.test-output/emulator-release-1792296292667.log`. Rules SHA256 `7092dd618bd9` on every rules compile in the run. The staff reconciliation test again exercised both deterministic proofs. Concurrency JOIN, concurrency CALL, and inactivity release passed. The inactivity contention case logged the expected rules evaluation errors and still passed with one winning start.

### Exact next action

Batch 4 closure records are complete for the deployed commit below. The annotated tag is local until a push is separately approved. 4F-4D remains deferred. Do not fold the two reconciliation proofs together, handle the opposite mixed view, weaken the pointer guard, or remove the test-only diagnostics without a separate approval.

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
| v0.4.0 | 9eece7d6f79c3503e9420dab1c6039f9509143ec | 2026-10-17, America/Los_Angeles | deployed and verified 2026-10-17 | deployed and verified 2026-10-17 |

For each component, record `deployed and verified` with its deployment date, or `unchanged from <release/commit>` after confirming it matches the release source. Record partial/pending deployment explicitly; never mark it complete merely because code was merged. For a retrospective entry, distinguish the actual release date from the later tag-creation date in a short note. If a historical value cannot be verified, mark it unknown rather than inventing it.

Batch 3 is reported released and production smoke tested at `b3b08809a2b8f4e0ff3d1fac672c8b63683ec688`. This ledger is intentionally incomplete until deployment dates/status evidence and the smoke-test record are recorded through review. No historical tag or release date is implied; `v0.3.0` remains proposed. Do not infer missing evidence from the commit date.

Batch 4 release note. Tag `v0.4.0` points at the deployed `main` commit `9eece7d6f79c3503e9420dab1c6039f9509143ec` (`chore: normalize AVA.md encoding`). That commit contains the Batch 4 product commit `973d3d44602685e78dbe73968b74144c884dad58`. `firestore.rules` is identical in both commits. Rules SHA256 prefix `7092dd618bd9`.

Frontend: GitHub Pages deployed and verified from `9eece7d6f79c3503e9420dab1c6039f9509143ec` on 2026-10-17 America/Los_Angeles. Pages run `39098506872`.

Rules: deployed and verified to Firebase project `turncue-83e1a` on 2026-10-17 America/Los_Angeles with `firebase deploy --only firestore:rules`. Indexes were not deployed by that command. The two Batch 4 `entries` composites, `status` + `ticketNumber` and `status` + `queueOrder` + `ticketNumber`, were already Enabled. Existing indexes were unchanged.

Release suite: `npm.cmd run test:release` passed all 35 tests on 2026-10-17. Log `.test-output/emulator-release-1792296292667.log`.

Production smoke: 12 of 12 steps passed on 2026-10-17 against the published pages and pilot test participants. A120 remains `completed`. Smoke ticket A121 was then removed from the active queue as `left_queue`, and Test Staff One's Window 2 shift was ended. John Cruz's Window 1 shift was unchanged. No active smoke ticket remains.

Limitations: this production smoke did not exercise inactivity auto-pause or close/reopen of an unassigned window. `v0.3.0` remains proposed and is not part of this row. The tag records the release and does not deploy anything. Pushing the tag requires a separate approval.
