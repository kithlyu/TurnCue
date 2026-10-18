import assert from "node:assert/strict";
import fs from "node:fs";
import { assessManagerSetup } from "../setup-status.js";

const session = { currentSessionId: "session-1" };
const staff = [{ id: "s1", name: "Existing Staff", active: false }];
const activeWindow = [{ id: "w1", name: "Window 1", active: true, retired: false }];
const retiredWindow = [{ id: "w2", name: "Window 2", active: false, retired: true }];

function assess(patch) {
  return assessManagerSetup({ serverConfirmed: true, queue: session, staff, windows: activeWindow, ...patch });
}

const fresh = assess({ staff: [], windows: [] });
assert.equal(fresh.status, "incomplete");
assert.deepEqual(fresh.missing, ["staff", "windows"]);
assert.equal(fresh.action, "staff");
assert.equal(fresh.actionLabel, "REGISTER A STAFF MEMBER");
assert.equal(fresh.next, "Next: register a staff member, then add a window. The queue session is already open.");
assert.deepEqual(fresh.steps, [
  { id: "session", label: "Queue session", done: true, state: "done", detail: "The queue session is saved." },
  { id: "staff", label: "Staff member", done: false, state: "next", detail: "Register a person in the staff roster below." },
  { id: "windows", label: "Window", done: false, state: "later", detail: "Add a window below. Staff choose it on Start Shift." }
]);

const needWindow = assess({ windows: [] });
assert.deepEqual(needWindow.missing, ["windows"]);
assert.equal(needWindow.action, "windows");
assert.equal(needWindow.actionLabel, "ADD WINDOWS");
assert.equal(needWindow.next, "Next: add a window, then ask staff to choose it on Start Shift.");
assert.deepEqual(needWindow.steps.map(step => [step.id, step.state, step.detail]), [
  ["session", "done", "The queue session is saved."],
  ["staff", "done", "A staff record is saved."],
  ["windows", "next", "Add a window below. Staff choose it on Start Shift."]
]);

const needStaff = assess({ staff: [], windows: retiredWindow });
assert.deepEqual(needStaff.missing, ["staff"]);
assert.equal(needStaff.action, "staff");
assert.equal(needStaff.next, "Next: register a staff member.");
assert.equal(needStaff.steps.find(step => step.id === "windows").done, true);
assert.equal(needStaff.steps.find(step => step.id === "windows").detail, "A window record is saved.");
assert.equal(needStaff.steps.find(step => step.id === "staff").state, "next");

const needSession = assess({ queue: { currentSessionId: "  " }, staff, windows: retiredWindow });
assert.deepEqual(needSession.missing, ["session"]);
assert.equal(needSession.action, null);
assert.equal(needSession.actionLabel, "");
assert.equal(needSession.next, "Next: reload this page to open the queue session.");
assert.deepEqual(needSession.steps.map(step => [step.id, step.state]), [
  ["session", "next"],
  ["staff", "done"],
  ["windows", "done"]
]);
assert.equal(needSession.steps.find(step => step.id === "staff").detail, "A staff record is saved.");
assert.equal(needSession.steps.find(step => step.id === "session").detail, "Reload this page to open the queue session.");

const missingQueue = assessManagerSetup({ serverConfirmed: true, queue: null, staff, windows: retiredWindow });
assert.equal(missingQueue.status, "incomplete");
assert.deepEqual(missingQueue.missing, ["session"]);

const configured = assess({ staff, windows: retiredWindow });
assert.equal(configured.status, "complete");
assert.deepEqual(configured.missing, []);
assert.equal(configured.next, "");
assert.equal(configured.action, null);
assert.deepEqual(configured.steps.map(step => step.state), ["done", "done", "done"]);
for (const step of configured.steps) assert.doesNotMatch(step.detail, /shift|open|active/i);
assert.equal(assess({}).status, "complete");

const existing = assessManagerSetup({
  serverConfirmed: true,
  queue: { name: "Main Queue", currentSessionId: "existing-session" },
  staff: [{ name: "Test Staff One", active: false, staffCode: "TC-EXISTING" }],
  windows: [{ name: "Window 1", retired: true }, { name: "Window 2", active: false, state: "inactive" }]
});
assert.equal(existing.status, "complete");

for (const input of [
  undefined,
  null,
  {},
  { serverConfirmed: false, queue: null, staff: [], windows: [] },
  { serverConfirmed: false, queue: session, staff, windows: retiredWindow },
  { serverConfirmed: true, queue: session, staff: null, windows: [] },
  { serverConfirmed: true, queue: session, staff: [], windows: undefined },
  { serverConfirmed: true, queue: "session-1", staff: [], windows: [] },
  { serverConfirmed: true, queue: [], staff: [], windows: [] }
]) {
  const result = assessManagerSetup(input);
  assert.equal(result.status, "unknown", "expected unknown for " + JSON.stringify(input));
  assert.deepEqual(result.missing, []);
  assert.equal(result.next, "");
  assert.equal(result.action, null);
  assert.deepEqual(result.steps, []);
}

const page = fs.readFileSync(new URL("../business.html", import.meta.url), "utf8");
assert(page.includes('import { assessManagerSetup } from "./setup-status.js"'));
assert(page.includes('freshness.confirmed(["queue", "staff", "windows"])'));
assert(page.includes('id="firstUse"'));
assert(page.includes('id="firstUseSteps"'));
assert(page.includes("It does not mean someone has started a shift."));
assert(page.includes('data-setup="unknown"'));
assert(!page.includes("setupComplete"));
assert(!page.includes("onboardingComplete"));
console.log("PASS manager setup detection");
