# Maintained focused checks

These are narrow engineering/release checkpoints, not a replacement for the coordinated manager/staff/customer production smoke test in the main README. No test command deploys anything or contacts live Firestore.

Navigation: [README](../README.md) · [Development workflow](../DEVELOPMENT.md) · [Release checklist](../RELEASE_CHECKLIST.md).

## Install once per checkout

Install Node **22.7+ within 22.x, or 24.x**, npm, and **Java 21+**. Make Java available on PATH, set `JAVA_HOME`, or set `TURNCUE_TEST_JAVA` to its executable. Then, from the repository root:

```powershell
npm ci
npm run test:setup
```

On Windows, use `npm.cmd` if PowerShell's execution policy blocks `npm.ps1`. No Firebase login, Firebase CLI, global Playwright installation, manually downloaded SDK files, or system Chrome is needed. Linux may additionally need the operating-system libraries required by Playwright Chromium (`npx playwright install-deps chromium`, using the locally installed CLI).

- `package.json` pins Playwright **1.58.2**; `package-lock.json` locks transitive dependencies and integrity values for `npm ci`.
- `tests/tooling.json` pins Firestore emulator **1.22.0** and browser SDK **12.19.0** URLs and SHA256 hashes.
- Setup downloads and checks assets into ignored `.test-tools/`, then installs Playwright's matching Chromium there. It performs network downloads only; it never initializes Firebase or accesses Firestore data.
- Tests do not download dependencies. Missing tools, bad asset checksums, or unavailable Java fail closed. Java is an external prerequisite, not automatically installed. There is no frontend build system.
- The frozen public configuration fixture records Batch 3 values; the fast environment test does not require old Git commits or a full clone.

## Commands

Run one command at a time. All children execute serially and stop at the first failure; there is no automatic retry.

| Command | Scope |
| --- | --- |
| `npm test` or `npm run test:fast` | Eight pure/source/environment/network-guard checks; no Java/browser/emulator required |
| `npm run test:rules` | Compile the current checkout rules in an isolated emulator project |
| `npm run test:browser` | Environment/recovery/outage checks, then the narrow Batch 3 manager browser checkpoint |
| `npm run test:concurrency` | JOIN, CALL NEXT, inactivity concurrent start; no two-minute expiry wait |
| `npm run test:integration` | Window operations, retired windows, immutable labels, label uniqueness |
| `npm run test:release` | Fast, rules, integration, browser, JOIN/CALL, then full inactivity checkpoint (including real two-minute expiry and concurrent start) |

Release usually takes several minutes; inactivity expiry deliberately uses real time. No accelerated clock or rules bypass is used for operations under test. Fixture seeding uses the local emulator's owner token only.

To rerun just a failed case after diagnosis, select its exact name from the runner's RUN line:

```powershell
npm run test:concurrency -- "concurrency call"
npm run test:integration -- window-operations
```

Exit codes: **0** passed selected checks, **1** test assertion/runtime failure or timeout, **2** setup/usage failure, **130** interrupted with Ctrl+C, **143** terminated. A failed gate does not imply a product bug: classify product, rules, test, or infrastructure before changing anything. Fix one thing and rerun only the affected case. Stop on a genuine product regression.

## Emulator ownership, isolation, and cleanup

Every emulator-backed command starts its own pinned JAR on **127.0.0.1:8787**, with this checkout's `firestore.rules`. Stop the local development emulator first: an occupied port is rejected, never reused. The runner ignores `.firebaserc`, does not call Firebase CLI, and does not require cloud credentials.

Each maintained emulator test compiles current rules into its own fresh `demo-*` project before fixtures/operations. JOIN and CALL use separate projects, and browser tests no longer use `demo-turncue-local`. Rules compilation prints the project and, in the shared compiler, a rules hash. Tests preload a fetch guard permitting only loopback emulator URLs for demo projects, including the SDK's streaming transport. Browser routes fulfill the two pinned SDK URLs from disk; other external requests are blocked. Production configuration checks use spies/fixtures without a production SDK connection.

Normal completion, failure, and Ctrl+C stop the runner-owned emulator. Its in-memory data is discarded; no import/export touches development or production. Test stderr (including expected SDK contention warnings) and emulator output are saved under ignored `.test-output/`; failures print diagnostic details and the log path. A forced OS kill/power loss can bypass cleanup: stop the leftover process before rerunning. The runner will refuse its occupied port.

Additional infrastructure verification, with setup complete and port 8787 free:

```powershell
node tests/runner-safety.mjs
```

This intentionally tests missing Java, absent emulator, and occupied-port refusal. Expected failures are asserted; the safety check itself exits 0 when all are correctly rejected.

## Maintained categories

| Category | Files | Status |
| --- | --- | --- |
| Pure/unit | `eta`, `eta-hardening`, `inactivity`, `bulk-setup`, `staff-import` | Fast + release |
| Source/environment | `inactivity-ui`, `environment`, `network-guard` | Fast + release; source checks are not browser interaction tests |
| Emulator/integration | `window-operations`, `retired-windows`, `window-label-immutability`, `window-label-uniqueness` | Integration + release |
| Inactivity integration | `inactivity-release` | Full serial state/expiry checks + concurrent start in release |
| Browser | `environment-browser`, `batch3-browser` | Browser + release |
| Concurrency | `concurrency join`, `concurrency call`, `inactivity-release --concurrent-only` | Concurrency + release (full inactivity run includes concurrent start once) |
| Rules | `rules` | Rules + release; other emulator suites also compile current rules |
| Runner safety | `runner-safety` | Focused infrastructure verification, separate from product release checks |
| Manual | Coordinated test in root README | Still needed for deployed network/index and multi-device behavior |

All named test files use `.mjs` under `tests/`.

The browser checkpoint remains narrow: current Add Windows previews/reset/cancel/create and CSV preview/import, unique Staff IDs, no assignment/shift side effects, and no uncaught page errors. Environment coverage verifies three-page scope agreement, same-device recovery, ignored legacy localhost keys, and emulator-outage errors. It is not a full staff/customer lifecycle browser suite.

JOIN requires six unique consecutive tickets and a matching counter with zero permission errors. CALL forces both clients to select the same first customer, then verifies two distinct assignments and matching pointers; the product's bounded retry may recover an expected candidate-lost permission denial. Inactivity requires exactly one successful start, one matching event, and the persisted pending check; the loser may return null or the previously accepted permission-denied response. Other rejections fail. The known inactivity rules expression-limit diagnostic remains a pilot limitation, not proof of a clean retry path.

## Legacy / historical — not release gates

These files are retained and unchanged by Slice 2:

- `batch2.mjs`: stale module allowlist, Batch 2 selectors/wording, and a direct-completion rejection assertion that overstates trusted-pilot authorization. Not a current browser gate.
- `bulk-concurrency.mjs`: fixed project, externally assumed rules, older rejection handling. Historical supplemental coverage only.
- `inactivity-concurrency.mjs`: fixed project, externally assumed rules, fail-fast handling; separate cancel mode remains historical. Concurrent start is maintained in `inactivity-release.mjs`.

Do not run historical files as evidence of current authorization or as release blockers. No historical tests were deleted or broadly rewritten. `firestore.indexes.json` remains a partial record of known deployed indexes; emulator compilation does not verify production index deployment.
