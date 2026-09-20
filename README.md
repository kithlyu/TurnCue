# TurnCue

Virtual queue pilot, Batch 2: Staff + Windows. GitHub Pages serves these files directly; no build step.

- Customer: https://kithlyu.github.io/TurnCue/
- Manager: https://kithlyu.github.io/TurnCue/business.html
- Staff: https://kithlyu.github.io/TurnCue/staff.html

## Architecture

Business → Location → Queue → Operational Session → Entries stays unchanged. The manager page initializes the development foundation and a session if needed. Development IDs remain `demo-business`, `main-location`, and `main-queue`.

Managers register staff and configure windows. Staff enter their generated ID, confirm their name, and explicitly choose an available window. A manager is a staff record with `role: manager` and can use the same staff page.

`turncue.js` shares Firestore operations between manager and staff pages; `turncue.css` shares their styling. The customer page retains the Batch 1 lifecycle, device recovery, tickets, and timing, with the called window added. Its ticket transaction is shared through join-entry.js: entry creation and the exact +1 counter update remain atomic. A bounded retry reuses the same entry ID only when a permission failure is accompanied by a server-confirmed counter advance; other permission errors surface.

- `staff/{id}`: permanent random internal ID; `staffCode`, `name`, `role`, `active`, `businessId`, `currentShiftId`, `currentWindowId`, `createdAt`, `updatedAt`.
- `staffCodes/{TC-XXXXXXXX}`: immutable visible-ID lookup with `staffId`, `businessId`, `createdAt`. IDs are reserved transactionally and never reused.
- `windows/{id}`: permanent resource with business/location/queue IDs, `name`, configured `active`, live `state` (`available`, `active`, `paused`, `inactive`), current staff/shift/entry/session/ticket pointers, `lastActionAt`, `stateChangedAt`, `lastEventId`, and creation/update timestamps.
- `shifts/{id}`: staff/window/scope IDs, `state` (`active`, `paused`, `ended`), exact `startedAt`/`endedAt`, current entry/session, `lastActionAt`. Ending clears live pointers, never removes history.
- `windowEvents/{id}`: append-only events with scope, staff/window/shift IDs, `type`, `fromState`, `toState`, `source` (`staff` or `manager`), `occurredAt`; customer events include session/entry IDs. `shift_started` also records the window becoming active; `shift_ended` records it becoming available. Pause/resume and call/completion are separate events.
- `sessions/{sessionId}/entries/{entryId}`: Batch 1 fields retained. Calls add `calledByStaffId`, `calledByShiftId`, `calledWindowId`, `calledWindowLabel`. No new serving state.

Start Shift updates staff, window, shift, and history atomically. One staff record can point to one shift, and one window can have one owner. Pause retains ownership and any called customer. End Shift requires no unresolved called customer. Rename/disable and staff deactivation require ending the shift first.

Call Next fetches the earliest waiting entry from the server, then transactionally rechecks that entry, the window, owner, shift, and current session. The transaction assigns the entry and updates the window/shift together. A losing caller fetches another candidate and retries (up to 12 fresh candidates, in addition to the SDK's transaction retries). Exhausted contention reports failure, never success. Completion clears both current-entry pointers atomically. A stale tab cannot act on a replacement shift. Existing Batch 1 called entries without a window can still be completed by the manager.

This is a trusted pilot, not secure authentication. Staff ID confirmation and manager access are not authorization boundaries. Rules provide pilot integrity: document shapes, local state transitions, immutable identity/history fields, and no deletes. They contain no cross-document lookups and cannot establish who is operating the browser. Ownership, active shifts, unresolved customers, waiting-candidate checks, atomic history writes, and one-assignment checks remain in client transactions. Direct API callers can bypass these cross-document client safeguards; this is not production staff authentication. Reads remain public, including the roster. No PIN, Cloud Functions, Blaze, or production authentication was added.

## Manual Firebase steps

Nothing is deployed automatically.

1. In Firebase project **turncue-83e1a**, open **Firestore Database → Rules**. Replace the entire rules editor with `firestore.rules` and publish.
2. Keep the existing `entries` collection-scope composite indexes: `status ASC + joinedAt ASC` and `status ASC + calledAt ASC`. `firestore.indexes.json` records these two known indexes.
3. No new composite indexes are expected: staff uses only `businessId == ...`, windows only `queueId == ...`, and Staff ID lookup is a direct document read. Keep automatic single-field indexes enabled for these fields. If Firebase reports a missing index, use its generated link from the browser console.
4. Do not delete old `/queue` documents or their indexes. This index file intentionally does not invent definitions for the historical indexes that were not included in the handoff. It is not a complete export of the deployed project's indexes; do not use it to remove indexes.
5. After separately approving and publishing the repository changes through GitHub Pages, reload all manager/staff tabs. Old Batch 1 dashboard Call Next writes will be rejected by the new assignment rules. Existing customer tabs remain compatible.
6. Open the manager URL. It preserves the current open session. Register staff and add windows through the page; no manual Firestore document setup is required. Then run the test below.

## One coordinated multi-device test

Use a manager browser, two separate staff devices/browser profiles, and three customer devices/profiles. Use a customer with an existing Batch 1 called entry too, if one exists.

1. On the manager page, confirm the existing operational session remains. Complete any earlier Batch 1 called entry. Register Maria as Staff and John as Manager, note their Staff IDs, and configure Window 1 and Window 2.
2. Both staff enter their own ID and confirm their name. Both choose Window 1 and start at nearly the same time. Exactly one must own it. The other must see an availability error and explicitly choose Window 2. Verify one staff cannot claim a second window from another tab.
3. Join three customers. Verify sequential unique tickets, live positions, and waiting states. Close/reopen one customer page using the same browser/profile: the same ticket returns without another entry.
4. Press Call Next on both staff devices together. They must receive different waiting customers, with the two earliest tickets called. Each customer sees the correct window. Calling again while occupied must be blocked.
5. Pause an occupied window. Ownership and its called customer stay in place; Call Next and End Shift remain blocked. Complete that customer while paused. Verify the customer completion screen and wait/service/total time, and that the window stays paused until Resume.
6. Have the third waiting customer leave and confirm cancellation and the manager's live waiting list. Complete the other called customer from the manager dashboard. The owning staff screen should release that customer immediately.
7. Use manager Pause/Resume on an assigned window and verify the staff screen follows. End a resolved shift. Confirm the window becomes available. Start another staff member there after a short gap; verify the old shift's `endedAt` and new shift's `startedAt` preserve the gap.
8. Mark an unassigned staff member inactive and confirm their ID cannot enter; reactivate and reuse the same permanent record. Rename/disable/re-enable an unassigned window. Confirm active shifts block deactivation/configuration changes.
9. Inspect `shifts` and `windowEvents` in Firebase: start/end, pause/resume, and call/completion timestamps remain; previous sessions, entries, and `/queue` data still exist. No duplicate customer assignment or overlapping ownership should have occurred.

Production network behavior and the deployed indexes still need this manual pilot test, even after local validation.

