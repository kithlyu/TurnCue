// Deterministic Batch 3 ETA helpers. Recent clean samples carry a little more
// weight; values are winsorized around the median so truthful outliers remain
// recorded without moving the customer estimate abruptly.
export const MIN_CLEAN_SAMPLES = 3;
export const STABLE_SAMPLE_COUNT = 5;
export const OVERDUE_CUSHION_MINUTES = 2;
export const OVERDUE_CUSHION_MAX_MINUTES = 5;
export function createEtaTicker(render, schedule = setInterval, cancel = clearInterval) {
  const id = schedule(render, 30000);
  return () => cancel(id);
}

const minutes = value => Math.max(0, Number(value) || 0);
export function sampleMinutes(sample) {
  if (sample.durationMinutes !== null && sample.durationMinutes !== undefined
    && Number.isFinite(Number(sample.durationMinutes)) && Number(sample.durationMinutes) > 0) return minutes(sample.durationMinutes);
  const called = sample.calledAt?.toMillis?.(), completed = sample.completedAt?.toMillis?.();
  return Number.isFinite(called) && Number.isFinite(completed) && completed >= called ? (completed - called) / 60000 : 0;
}
const median = values => {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function learnPace(samples) {
  const clean = samples.filter(s => s.cleanEligible !== false && sampleMinutes(s) > 0).slice(-40);
  if (clean.length < MIN_CLEAN_SAMPLES) return { confidence: "calibrating", count: clean.length, paceMinutes: null };
  const raw = clean.map(sampleMinutes);
  const center = median(raw), mad = median(raw.map(value => Math.abs(value - center)));
  // At least ±2 minutes prevents low-variance data from clipping harmless variation.
  const cap = Math.max(2, mad * 3);
  const bounded = raw.map(value => Math.max(center - cap, Math.min(center + cap, value)));
  // Weighted median: newest samples get weights 1..N, retaining historical usefulness.
  const weighted = bounded.flatMap((value, index) => Array(index + 1).fill(value));
  const paceMinutes = median(weighted);
  const recent = bounded.slice(-STABLE_SAMPLE_COUNT);
  const recentMedian = median(recent);
  const recentMad = median(recent.map(value => Math.abs(value - recentMedian)));
  // Stable only after five samples and when typical recent deviation is <= 25% (minimum 1 min).
  const stable = clean.length >= STABLE_SAMPLE_COUNT && recentMad <= Math.max(1, recentMedian * .25);
  return { confidence: stable ? "stable" : "early", count: clean.length, paceMinutes, medianMinutes: center, madMinutes: mad };
}

export function estimateWait({ samples, windows, waitingEntries, entryId, now = Date.now() }) {
  const learned = learnPace(samples);
  const index = waitingEntries.findIndex(entry => entry.id === entryId);
  const ahead = index < 0 ? 0 : index;
  const active = windows.filter(window => window.retired !== true && window.active && window.state === "active" && window.currentShiftId);
  if (!active.length) return { ...learned, ahead, mode: "no_capacity", minutes: null };
  if (!learned.paceMinutes) return { ...learned, ahead, mode: "calibrating", minutes: null };
  const paceMs = learned.paceMinutes * 60000;
  const slots = active.map(window => {
    if (!window.currentEntryId || !window.currentEntryCalledAt?.toMillis) return 0;
    const elapsed = Math.max(0, now - window.currentEntryCalledAt.toMillis());
    const remaining = paceMs - elapsed;
    const cushion = Math.min(OVERDUE_CUSHION_MAX_MINUTES * 60000, Math.max(OVERDUE_CUSHION_MINUTES * 60000, paceMs * .25));
    return Math.max(cushion, remaining);
  });
  for (let customer = 0; customer < ahead; customer++) {
    const next = slots.indexOf(Math.min(...slots));
    slots[next] += paceMs;
  }
  const waitMs = Math.min(...slots);
  return { ...learned, ahead, mode: learned.confidence, minutes: waitMs / 60000 };
}

export function etaCopy(estimate) {
  if (estimate.mode === "no_capacity") return { title: "Service is temporarily not moving.", detail: "Your place in line is saved." };
  if (estimate.mode === "calibrating") return { title: "Nice timing, you’re early!", detail: "ETA is calibrating as service gets underway." };
  const rounded = Math.max(1, Math.round(estimate.minutes));
  if (estimate.mode === "stable") return { title: "Estimated wait", detail: "About " + rounded + " min", numeric: true, mode: "stable", lower: rounded, upper: rounded };
  if (rounded <= 5) return { title: "Early estimate", detail: "About " + rounded + " min", numeric: true, mode: "early", lower: 0, upper: 5 };
  const lower = Math.max(5, Math.floor(rounded / 5) * 5), upper = lower + 5;
  return { title: "Early estimate", detail: "About " + lower + "–" + upper + " min", numeric: true, mode: "early", lower, upper };
}
