export const ARRIVAL_WINDOW_MS = 120000;

// Derived from the persisted call, so refresh and presence confirmation never
// restart either clock. A different attempt has no actionable arrival decision.
export function serviceTiming(entry, expectedCallAttemptId, now = Date.now()) {
  const called = entry?.calledAt?.toMillis?.();
  const active = ["called", "in_progress"].includes(entry?.status)
    && (entry.callAttemptId ?? null) === (expectedCallAttemptId ?? null) && Number.isFinite(called);
  const elapsedMs = active ? Math.max(0, now - called) : 0;
  return {
    active, elapsedSeconds: Math.floor(elapsedMs / 1000),
    remainingSeconds: Math.ceil(Math.max(0, ARRIVAL_WINDOW_MS - elapsedMs) / 1000),
    arrivalDecision: active && entry.status === "called" && elapsedMs >= ARRIVAL_WINDOW_MS
  };
}

export function clockText(seconds) {
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}
