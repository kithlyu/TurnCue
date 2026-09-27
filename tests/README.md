# Batch 3 release checkpoint

The full automated regression and coordinated manager/staff/customer manual smoke test were reported green before release-prep. These focused checkpoints preserve the temporary release-verification adaptations; they do not claim to replace that full regression or production network/index smoke testing.

## Prerequisites and isolation

- Node.js 22+ (VM module tests require `--experimental-vm-modules`).
- Java 21 and a Firestore emulator JAR, or Firebase CLI with its Firestore emulator installed.
- Local Firebase browser SDK 12.19.0 files `firebase-app.js` and `firebase-firestore.js` in `TURNCUE_TEST_ASSETS`. Obtain these exact files from `https://www.gstatic.com/firebasejs/12.19.0/` before running offline tests.
- Playwright available to Node (set `NODE_PATH` to its containing `node_modules` if needed), and Chrome. Set `TURNCUE_TEST_BROWSER` to another Chromium executable when necessary.

Start an emulator in a separate terminal, with logs outside the repository (substitute absolute paths):

```powershell
java -jar <firestore-emulator.jar> --host 127.0.0.1 --port 8787 --rules <repo>/firestore.rules --project_id demo-turncue-release
```

The maintained checkpoints hard-code loopback port 8787, create a fresh `demo-` project per invocation, and compile this checkout's rules into that project. They do not use `.firebaserc` or production data. The browser serves all current local runtime modules and fulfills only the two pinned SDK URLs from disk; other non-loopback requests are blocked. The VM checkpoint blocks non-loopback fetches. Run tests serially and stop at the first failure; classify product, rules, test, or infrastructure before making a surgical fix.

## Focused commands

From the repository root, after setting the prerequisites above:

```powershell
node tests/batch3-browser.mjs
node --experimental-vm-modules tests/inactivity-release.mjs
```

- `batch3-browser.mjs`: JavaScript syntax and index JSON; rules compilation; manager module loading; Add Windows initial disabled state, numbered preview after highest label (1 and 5 produce 6 and 7), additional quantity, no gap filling, cancel/reset, actual creation without assignment, independent letter preview; CSV preview/create, unique Staff IDs, no windows/shifts assigned, repeat-submit blocked; no uncaught page errors.
- `inactivity-release.mjs`: serial pending start, staff confirmation and action-time reset, empty-queue cancellation, real two-minute deadline followed by auto-pause with retained ownership/shift and review flag, and concurrent single-winner start. Checks persisted states and event counts. Real expiry intentionally takes roughly two minutes; it does not accelerate the clock or bypass expiry rules. A contention loser may return null or the known permission-denied response; unrelated rejections fail, and exactly one successful check/event must still exist. The release-prep run observed the known loser permission denial with the rules expression-limit diagnostic; this is recorded as a contention limitation, not proof of a clean retry path.

Small pure focused suites can be run individually with `node tests/<name>.mjs`: `eta`, `eta-hardening`, `inactivity`, `inactivity-ui`, `bulk-setup`, `staff-import`. Existing VM suites `window-operations`, `retired-windows`, `window-label-immutability`, and `window-label-uniqueness` use the same emulator/assets and VM flag; run them only when the corresponding implementation changes.

## Legacy caveats safe to defer

- `batch2.mjs` is a historical broad harness, not the Batch 3 release gate. Its HTTP allowlist lacks current modules; window selectors and disable/re-enable wording predate Add Windows and OPEN/CLOSED; its direct-completion rejection assertion overstates the trusted-pilot rules. Do not interpret that assertion as an authorization guarantee. Cross-document safeguards remain client transactions, as documented in the main README. A broad rewrite is deferred; current browser coverage is in `batch3-browser.mjs`.
- `inactivity-concurrency.mjs` uses a fixed emulator project, does not independently load/compile current rules, and uses fail-fast rejection handling. It is superseded for the release's concurrent-start checkpoint by `inactivity-release.mjs`. Its separate concurrent-cancel mode is historical supplemental coverage, not a maintained release gate.
- `bulk-concurrency.mjs` likewise uses a fixed project and old rejection handling, and assumes emulator rules setup externally. Keep it as historical supplemental coverage; do not use it as the Batch 3 release gate. Current focused label-generation and uniqueness suites plus the accepted prior regression cover this unchanged area. A dedicated bulk race-harness refresh is deferred.
- Never add temporary logs, emulator output, coverage, SDK/JAR downloads, or screenshots from `%TEMP%` to the commit. The maintained checkpoints generate no screenshots or coverage files.

`.firebaserc` records the live project alias; `firebase.json` records the repository rules/index paths. Both belong in configuration review, but neither is a deployment instruction. Always select a `demo-` project for emulator work. The index file is intentionally not a full deployed-index export; do not use it to remove live indexes.
