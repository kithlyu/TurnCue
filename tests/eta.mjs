import assert from "node:assert/strict";
import { learnPace, estimateWait, etaCopy } from "../eta.js";

const sample = durationMinutes => ({ cleanEligible: true, durationMinutes });
const active = (id, currentEntryId = null, elapsedMinutes = 0) => ({ id, active: true, state: "active", currentShiftId: id + "-shift", currentEntryId, currentEntryCalledAt: currentEntryId ? { toMillis: () => Date.now() - elapsedMinutes * 60000 } : null });

for (const count of [0, 1, 2]) assert.equal(learnPace(Array.from({ length: count }, () => sample(8))).confidence, "calibrating");
const early = learnPace([sample(8), sample(9), sample(10)]);
assert.equal(early.confidence, "early");
assert.equal(etaCopy({ ...early, mode: "early", minutes: 12 }).detail, "About 10–15 min");

const outlier = learnPace([sample(8), sample(8), sample(9), sample(8), sample(60)]);
assert(outlier.paceMinutes < 15, "A truthful long outlier must be dampened, not dominate pace.");
assert.equal(learnPace([sample(5), sample(14), sample(7), sample(16), sample(9)]).confidence, "early");
assert.equal(learnPace([sample(8), sample(8), sample(9), sample(8), sample(9)]).confidence, "stable");

const history = [sample(8), sample(8), sample(8), sample(8), sample(8)];
const waiting = [{ id: "one" }, { id: "two" }, { id: "three" }];
const staggered = estimateWait({ samples: history, windows: [active("one", "busy", 6), active("two", "busy", 2)], waitingEntries: waiting, entryId: "three" });
// ETA is when a window becomes available for the target, not when an earlier customer starts.
assert(Math.abs(staggered.minutes - 10) <= .25, "Staggered windows must schedule the target from next availability, not average capacity.");
assert.equal(estimateWait({ samples: history, windows: [{ ...active("paused"), state: "paused" }], waitingEntries: waiting, entryId: "one" }).mode, "no_capacity");
assert.notEqual(estimateWait({ samples: history, windows: [active("resumed")], waitingEntries: waiting, entryId: "one" }).mode, "no_capacity");
const calibration = etaCopy(estimateWait({ samples: [], windows: [active("one")], waitingEntries: waiting, entryId: "one" }));
assert.equal(calibration.title, "Nice timing, you’re early!");
const getReady = etaCopy({ mode: "early", minutes: 5, confidence: "early" });
assert.equal(getReady.numeric, true);
console.log("Batch 3A ETA focused tests: PASS");
