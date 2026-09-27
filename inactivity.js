// Batch 3B-1 has no scheduler. These pure decisions are invoked by the future
// operational-page evaluator with Firestore's resolved timestamps.
export const CHECK_RESPONSE_MINUTES = 2;
export function inactivityThresholdMinutes(learned) {
  return learned?.confidence === "calibrating" || !Number.isFinite(learned?.paceMinutes) ? null : learned.paceMinutes * 2;
}
export function isInactivityEligible(window, hasWaiting, learned) {
  return Boolean(hasWaiting && window?.retired !== true && window?.active && window.state === "active" && window.currentShiftId && window.currentStaffId && !window.currentEntryId && !window.inactivityCheckState && inactivityThresholdMinutes(learned));
}
export function isInactivityDue(window, hasWaiting, learned, now = Date.now()) {
  const threshold = inactivityThresholdMinutes(learned);
  const lastAction = window?.lastActionAt?.toMillis?.();
  return isInactivityEligible(window, hasWaiting, learned) && Number.isFinite(lastAction) && now - lastAction >= threshold * 60000;
}
export function isCheckExpired(window, now = Date.now()) {
  const deadline = window?.inactivityCheckDeadline?.toMillis?.();
  return window?.inactivityCheckState === "pending" && Number.isFinite(deadline) && now >= deadline;
}
export function pendingCheckDecision(window, hasWaiting, now = Date.now()) {
  if (!isCheckExpired(window, now)) return "none";
  if (!hasWaiting || window.state !== "active" || window.currentEntryId) return "cancel";
  return "auto_pause";
}
