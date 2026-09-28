# TurnCue current architecture

Navigation: [README](../README.md) · [Development/release ledger](../DEVELOPMENT.md) · [Release checklist](../RELEASE_CHECKLIST.md) · [Rollback](../ROLLBACK.md) · [Tests](../tests/README.md).

This describes the current Batch 3 product and locally accepted engineering foundation. It is not a deployment record or a design for future features.

## Runtime and environment boundary

GitHub Pages serves static HTML, CSS, and JavaScript without a build step. `index.html` handles customer join, ticket recovery, status, and ETA; `business.html` handles manager operations; `staff.html` handles staff identification and window/shift operations. Browsers use the Firebase SDK directly. There is no application server or Cloud Functions layer.

`turncue.js` shares manager/staff Firestore operations; small modules isolate JOIN, ETA, inactivity, staff import, bulk setup, and window logic. `environment.js` owns Firebase configuration and scope; `firebase-client.js` initializes the shared client used by all three pages.

| Host | Firebase project | Connection |
| --- | --- | --- |
| `kithlyu.github.io` | `turncue-83e1a` | Production Firestore; no emulator connection |
| `localhost`, `127.0.0.1`, IPv6 loopback | `demo-turncue-local` | Firestore emulator at `127.0.0.1:8787` only |
| Any other host, including file URLs | None | Initialization blocked |

Both environments use `demo-business / main-location / main-queue`; their project identities isolate data. Local initialization connects to the emulator before operations and checks reachability. An unavailable emulator produces a visible development error; there is no production fallback or query-parameter override. The local server compiles current checkout rules before serving. Maintained tests use separate isolated `demo-*` projects and load current rules; see the test guide for tooling and network guards.

Customer recovery/get-ready storage keys include project, business, location, and queue, within browser-origin storage. Production alone migrates old unqualified keys to preserve same-device tickets. Local pages ignore those old keys, preventing recovery of a previous production-connected localhost ticket. This is browser storage handling, not a Firestore migration.

## Data relationships and history

The logical hierarchy is **Business → Location → Queue → Operational Session → Entries**. Most entities are top-level collections linked by IDs; this is not a fully nested collection tree.

| Data | Role |
| --- | --- |
| `businesses`, `locations`, `queues` | Scope; the queue points to its current session |
| `sessions/{sessionId}/entries/{entryId}` | Session ticket counter and customer lifecycle; entries retain scope and call/window references |
| `staff`, `staffCodes` | Permanent staff records and immutable generated Staff ID lookup/reservations |
| `windows`, `windowLabels` | Durable window resources and immutable label reservations |
| `shifts` | Staff/window ownership with retained start/end timestamps |
| `windowEvents` | Append-only operational events with scope, actor/resource references, source, and timestamps |
| `queues/{queueId}/serviceSamples/{entryId}` | Immutable, deterministic per-entry service samples for ETA |

Live pointers on staff, windows, and shifts describe current assignment. Ending a shift or completing a customer clears the relevant live pointers while retaining history. Session entries and shifts transition through their lifecycle; they are not wholly immutable documents. Historical `/queue` data is retained, not the current runtime model.

TurnCue-generated Staff IDs are permanent identity; names are display data. Staff import creates records and IDs, never window assignments or shifts. Staff ID entry/name confirmation is not authentication.

Windows are durable resources. Labels are immutable for beta; closing/reopening preserves the record and label. Retired windows remain hidden from normal operations and excluded from shift selection, inactivity evaluation, and ETA capacity, while their records/history remain. Pause retains ownership and any called customer; ending a shift requires that customer to be resolved.

**Current scope limitation:** `windowLabels/{normalizedLabel}` uses a global reservation namespace, even though documents contain scope fields. This is safe only for the current single-business/single-queue use. It must be revisited before supporting independent queues/businesses with overlapping labels; the scoped fields alone do not make it multi-business ready.

## Transaction-sensitive operations

- **JOIN:** entry creation and exact +1 session ticket-counter update are atomic in `join-entry.js`. SDK transaction retries reuse the entry ID; an existing matching entry returns its ticket. There is no custom bounded permission-denied retry wrapper; permission failures surface normally.
- **CALL NEXT:** fetch the earliest waiting candidate, then transactionally recheck the candidate, current session, window, staff, and shift before assigning it. Contention can select another candidate, up to 12 fresh candidates plus SDK transaction retries. A permission-denied retry requires server evidence that the candidate left waiting; other permission failures surface. Completion clears assignment pointers and records history/sample atomically.
- **Inactivity:** start, confirmation, and expiry resolution use transactions for single-winner transitions and recheck eligibility. Concurrent evaluators must not create duplicate pending checks/events.
- Staff ID/window-label reservation, shift start/end, and pause/resume also use transactions to keep related current state and history together in the normal client workflow.

These are client transaction safeguards. They are not a claim that rules independently enforce every cross-document relationship.

## Client-side Spark behavior and access limits

ETA uses the newest 40 service samples, filters eligible samples, and computes a robust learned pace and active staffed-window capacity in the browser. Paused, closed, unstaffed, and retired windows do not add capacity. Estimates remain estimates, not service guarantees.

Inactivity checks are best-effort browser work: an open manager/staff page evaluates every 30 seconds. An eligible empty assigned window with waiting customers can receive a two-minute pending check after twice the learned pace of inactivity. Expiry rechecks conditions before auto-pausing; an empty queue cancels the check. Persisted state survives refresh, but no server watchdog runs when pages are closed. The accepted concurrent-start loser may produce a permission-denied/rules-expression-limit diagnostic; the maintained test verifies one pending check/event, not a clean loser retry path.

This remains a **trusted pilot without real authentication/authorization**. Manager-page access and Staff IDs are not security boundaries. Reads, including roster data, are public. Rules constrain shapes, local transitions, immutable fields/history, and deletes, but lack cross-document lookups; direct API callers can bypass relationships enforced only by client transactions. This access model is not ready for a broad external rollout.

Frontend and rules deploy independently and can drift; open tabs can retain another frontend version. The release checklist owns compatibility/verification gates and the rollback guide owns recovery. Source rollback does not restore data. `firestore.indexes.json` is only a partial known-index record, not a complete deployed inventory.
