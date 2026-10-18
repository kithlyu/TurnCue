// Minimum manager setup is derived from data the manager page has already loaded.
// Completion means a queue session, at least one staff record, and at least one window exist.
// Inactive staff and retired or closed windows still count. Completion is not a shift or an open counter.
// A read that is missing, cached, pending, or failed stays unknown so it is not treated as incomplete.
// steps describes those same three checks for the manager guide. It does not add a completion rule.

const ACTION_LABEL = { staff: "REGISTER A STAFF MEMBER", windows: "ADD WINDOWS" };
const STEP_COPY = {
  session: { label: "Queue session", done: "The queue session is saved.", todo: "Reload this page to open the queue session." },
  staff: { label: "Staff member", done: "A staff record is saved.", todo: "Register a person in the staff roster below." },
  windows: { label: "Window", done: "A window record is saved.", todo: "Add a window below. Staff choose it on Start Shift." }
};

function unknown() {
  return { status: "unknown", missing: [], next: "", action: null, actionLabel: "", steps: [] };
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

function stepsFor(missing) {
  const nextId = missing.includes("session") ? "session" : missing.includes("staff") ? "staff" : missing.includes("windows") ? "windows" : null;
  return ["session", "staff", "windows"].map(id => {
    const done = !missing.includes(id);
    const copy = STEP_COPY[id];
    return { id, label: copy.label, done, state: done ? "done" : id === nextId ? "next" : "later", detail: done ? copy.done : copy.todo };
  });
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
  const steps = stepsFor(missing);
  if (!missing.length) return { status: "complete", missing, next: "", action: null, actionLabel: "", steps };
  const action = actionFor(missing);
  return { status: "incomplete", missing, next: nextStep(missing), action, actionLabel: action ? ACTION_LABEL[action] : "", steps };
}
