# TurnCue

Static browser-based virtual queue pilot. GitHub Pages serves the customer (`index.html`), manager (`business.html`), and staff (`staff.html`) pages directly; there is no frontend build step.

## Engineering guide

| Document | Purpose |
| --- | --- |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Branches, review/approval gates, annotated release tags, and release ledger |
| [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) | Canonical current release process and production smoke test |
| [ROLLBACK.md](ROLLBACK.md) | Recovery after a bad release; separate frontend/rules decisions and data limits |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Current runtime, data relationships, invariants, and pilot limitations |
| [tests/README.md](tests/README.md) | Pinned tooling, maintained commands, isolation, and historical test classification |
| [AGENTS.md](AGENTS.md) | Focused development rules |

Batch 3 is released and production smoke tested at `b3b08809a2b8f4e0ff3d1fac672c8b63683ec688`. The accepted engineering foundation remains local and uncommitted; local acceptance does not publish it. See the intentionally incomplete release ledger in DEVELOPMENT.md for evidence requirements.

An approved push to `main` automatically triggers GitHub Pages publication; verify deployment success and its source commit. Firestore rules deploy separately. Use RELEASE_CHECKLIST.md for both surfaces; it supersedes the old Firebase Console copy/publish instructions and Batch 1/2 release advice.

## Install and check

Use Node **22.7+ within 22.x, or 24.x**, npm, and **Java 21+**. From the repository root:

```powershell
npm ci
npm run test:setup
npm run test:fast
```

Setup provisions pinned tooling in `.test-tools/`; no manual emulator JAR or global browser installation is needed. On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`. See [tests/README.md](tests/README.md) for Java discovery and platform prerequisites. The maintained release command is `npm run test:release`. Run commands serially; emulator-backed checks own port 8787, so stop local development first.

## Safe local development

After setup, make Java available as `java` on PATH and use two terminals from the repository root:

```powershell
# Terminal 1: provisioned emulator, isolated demo project, current rules.
java -jar .test-tools/cloud-firestore-emulator-v1.22.0.jar --host 127.0.0.1 --port 8787 --rules firestore.rules --project_id demo-turncue-local
```

```powershell
# Terminal 2: compile current rules into the local project, then serve pages.
node scripts/dev.mjs
```

Open [local manager](http://127.0.0.1:8080/business.html) first to initialize local data, then [local staff](http://127.0.0.1:8080/staff.html) and [local customer](http://127.0.0.1:8080/). The server can use an existing loopback emulator on that port, always loads current rules, and stops if setup fails. Restart it after rules edits; reload pages after runtime edits. Ctrl+C stops each process. Emulator data is not exported or preserved across restarts.

Loopback pages use only `demo-turncue-local` at `127.0.0.1:8787`; an unavailable emulator blocks initialization with a development error. Unknown hosts are blocked and there is no production fallback. No Firebase login or cloud project is needed. Ordinary development downloads the pinned SDK from Google's CDN, not Firestore data; maintained browser tests serve that SDK from disk and block external requests.

Recovery keys are environment/scope-qualified. Use the same hostname, port, and browser profile for local ticket recovery. See [architecture](docs/ARCHITECTURE.md) for production configuration and legacy recovery handling.

## Coordinated manual smoke guide

Use the local emulator before publication: one manager browser, two staff profiles, and three customer profiles. Production testing requires separate explicit approval for live operational writes and follows [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md). Do not reset real sessions or data to create fixtures.

1. Confirm the manager preserves the current open session. Register two test staff and configure two windows locally; use agreed pilot participants/resources in production.
2. Have both staff claim the same window nearly simultaneously. Exactly one succeeds; the loser explicitly chooses the other window. Verify the same staff cannot claim a second window from another tab.
3. Join three customers; verify unique sequential tickets and live positions. Close/reopen one page in the same profile: its ticket returns without another entry.
4. Call Next concurrently on both staff pages. They receive different customers, the earliest two tickets, with correct window labels. An occupied window cannot call again.
5. Pause an occupied window: ownership/customer remain and Call Next/End Shift are blocked. Complete while paused; check customer completion/timing and that Resume is needed to return the window to OPEN.
6. Cancel the third waiting customer and check the manager list. Complete the other called customer from the manager; its staff page releases the customer immediately.
7. Check manager Pause/Resume synchronization. End a resolved shift and start another staff member after a gap; preserve both shift timestamps and the gap.
8. Deactivate/reactivate an unassigned staff member and verify the same permanent ID works again. CLOSE/OPEN an unassigned window without changing its label. Active shifts must block these configuration changes.
9. Inspect local emulator history for shift, pause/resume, and call/completion events and retained earlier sessions. Any production history inspection also requires explicit approval. Check for duplicate assignments or overlapping ownership. If a historical called entry without a window exists, verify manager completion compatibility; do not manufacture legacy production data.

Production network/index behavior still needs the approved production smoke test. Historical Batch 1/2 harnesses are classified in the test README and are not current release gates.
