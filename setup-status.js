// Minimum manager setup is derived from data the manager page has already loaded.
// Inactive staff and retired windows still count: an existing business is not first use.
// A read that is missing, cached, pending, or failed stays unknown so it is not treated as incomplete.

const ACTION_LABEL = { staff: "REGISTER A STAFF MEMBER", windows: "ADD WINDOWS" };

function unknown() {
  return { status: "unknown", missing: [], next: "", action: null, actionLabel: "" };
}

function sessionId(queue) {
  const value = queue && typeof queue.currentSessionId === "string" ? queue.currentSessionId.trim() : "";
  return value;
}

function nextStep(missing) {
  if (missing.includes("session")) return "Next: reload this page to open the queue session.";
  if (missing.includes("staff") && missing.includes("windows")) return "Next: register a staff member, then add a window. The queue session is already open.";
  if (missing.includes("staff")) return "Next: register a staff member.";
  return "Next: add a window, then ask staff to choose it on Start Shift.";
}

function actionFor(missing) {
  if (missing.includes("session")) return null;
  if (missing.includes("staff")) return "staff";
  return missing.includes("windows") ? "windows" : null;
}

export function assessManagerSetup(input) {
  if (!input || input.serverConfirmed !== true) return unknown();
  const { queue, staff, windows } = input;
  if (!Array.isArray(staff) || !Array.isArray(windows)) return unknown();
  if (queue !== null && (typeof queue !== "object" || Array.isArray(queue))) return unknown();
  const missing = [];
  if (!sessionId(queue)) missing.push("session");
  if (staff.length === 0) missing.push("staff");
  if (windows.length === 0) missing.push("windows");
  if (!missing.length) return { status: "complete", missing, next: "", action: null, actionLabel: "" };
  const action = actionFor(missing);
  return { status: "incomplete", missing, next: nextStep(missing), action, actionLabel: action ? ACTION_LABEL[action] : "" };
}
