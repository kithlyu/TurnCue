// Presentation only: preserve the stored states and historical event vocabulary.
export function windowStatus(window) {
  if (window.retired === true) return null;
  if (!window.active) return "CLOSED";
  return window.state === "paused" ? "PAUSED" : "OPEN";
}

export function canConfigureWindow(window) {
  return window.retired !== true
    && !window.currentStaffId && !window.currentShiftId
    && !window.currentEntryId && !window.currentSessionId
    && (window.active ? window.state === "available" : window.state === "inactive");
}
