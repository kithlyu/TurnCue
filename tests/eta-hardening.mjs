import assert from "node:assert/strict";
import { createEtaTicker, estimateWait, etaCopy, learnPace } from "../eta.js";

let tick, delay, cancelled = false, renders = 0;
const stop = createEtaTicker(() => { renders++; }, (fn, ms) => { tick = fn; delay = ms; return "timer"; }, id => { cancelled = id === "timer"; });
assert.equal(delay, 30000);
tick();
assert.equal(renders, 1, "A local timer tick must render without a Firestore event.");
stop(); assert(cancelled, "The waiting ETA timer must be clearable.");
const now = 1_000_000_000, samples = [{ cleanEligible: true, durationMinutes: 8 }, { cleanEligible: true, durationMinutes: 8 }, { cleanEligible: true, durationMinutes: 8 }];
const window = { id: "w", active: true, state: "active", currentShiftId: "s", currentEntryId: "c", currentEntryCalledAt: { toMillis: () => now - 2 * 60000 } };
const before = estimateWait({ samples, windows: [window], waitingEntries: [{ id: "target" }], entryId: "target", now });
const after = estimateWait({ samples, windows: [window], waitingEntries: [{ id: "target" }], entryId: "target", now: now + 60000 });
assert(etaCopy(before).numeric && before.minutes > 5 && after.minutes <= 5, "A timer-only recalculation must be able to cross the Get Ready threshold.");

const stamped = [{ cleanEligible: true, durationMinutes: null, calledAt: { toMillis: () => 1000 }, completedAt: { toMillis: () => 481000 } }, { cleanEligible: true, calledAt: { toMillis: () => 1000 }, completedAt: { toMillis: () => 481000 } }, { cleanEligible: true, calledAt: { toMillis: () => 1000 }, completedAt: { toMillis: () => 481000 } }];
assert.equal(Math.round(learnPace(stamped).paceMinutes), 8, "Learning duration must derive from resolved Firestore timestamps, not Date.now().");
console.log("Batch 3A ETA hardening focused tests: PASS");
