// Local-only browser/Firestore integration tests. No production requests allowed.
// Requires Playwright, Chrome/Edge, and the Firestore emulator on 127.0.0.1:8787.
// Set TURNCUE_TEST_ASSETS to a folder containing the two Firebase 12.19.0 SDK files.
// NODE_PATH may point to an existing Playwright installation; no app dependency.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = process.env.TURNCUE_TEST_ASSETS;
assert(assets, "Set TURNCUE_TEST_ASSETS to the local SDK folder.");
const project = "demo-turncue-batch2";
const emulator = "http://127.0.0.1:8787";
const api = emulator + "/v1/projects/" + project + "/databases/(default)/documents";
const sdk = "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
const scope = { businessId: "demo-business", locationId: "main-location", queueId: "main-queue" };
let checks = 0;
function passed(name) { checks++; console.log("PASS " + name); }

for (const file of ["index.html", "business.html", "staff.html", "turncue.js"]) {
  const content = fs.readFileSync(path.join(root, file), "utf8");
  const scripts = file.endsWith(".html") ? [...content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]) : [content];
  for (const source of scripts) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source, encoding: "utf8" });
    assert.equal(result.status, 0, file + ": " + result.stderr);
  }
}
JSON.parse(fs.readFileSync(path.join(root, "firestore.indexes.json"), "utf8").replace(/^\uFEFF/, ""));
passed("all JavaScript syntax and index JSON");

const rulesResponse = await fetch(emulator + "/emulator/v1/projects/" + project + ":securityRules", {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content: fs.readFileSync(path.join(root, "firestore.rules"), "utf8").replace(/^\uFEFF/, "") }] } })
});
assert(rulesResponse.ok, await rulesResponse.text());
passed("current Firestore rules compile in the emulator");

// Reset only the hard-coded loopback emulator and demo project.
const reset = await fetch(emulator + "/emulator/v1/projects/" + project + "/databases/(default)/documents", { method: "DELETE" });
assert(reset.ok, await reset.text());
const server = http.createServer((request, response) => {
  const file = decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1) || "index.html";
  if (!["index.html", "business.html", "staff.html", "turncue.js", "turncue.css"].includes(file)) { response.writeHead(404).end(); return; }
  let content = fs.readFileSync(path.join(root, file), "utf8");
  if (file === "turncue.js") {
    content = content.replace("getFirestore, doc,", "getFirestore, connectFirestoreEmulator, doc,");
    content = content.replace("getFirestore(initializeApp(firebaseConfig));", 'getFirestore(initializeApp(firebaseConfig));\nconnectFirestoreEmulator(db, "127.0.0.1", 8787);');
    // Test-only gate forces two devices to select the same candidate.
    content = content.replace("const candidateRef = candidates.docs[0].ref;", "const candidateRef = candidates.docs[0].ref; await window.__candidateSelected?.(candidateRef.id);");
  }
  if (file === "index.html") {
    content = content.replace("getFirestore,", "getFirestore, connectFirestoreEmulator,");
    content = content.replace("const db = getFirestore(app);", 'const db = getFirestore(app);\nconnectFirestoreEmulator(db, "127.0.0.1", 8787);');
  }
  content = content.replaceAll("turncue-83e1a", project);
  response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
  response.end(content);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.TURNCUE_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe"
});
const errors = [];
const contexts = [];
async function pageAt(file, viewport = { width: 1100, height: 900 }) {
  const context = await browser.newContext({ viewport });
  contexts.push(context);
  // Both SDK modules are served from disk. ALL other external traffic is blocked.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) {
      return route.fulfill({ path: path.join(assets, path.basename(url.pathname)), contentType: "text/javascript" });
    }
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", entry => { if (entry.type() === "error") console.log("BROWSER " + file + ": " + entry.text().slice(0, 1200)); });
  await page.goto(origin + "/" + file);
  return page;
}
async function operation(page, method, ...args) {
  return page.evaluate(async ({ method, args }) => {
    const app = await import("/turncue.js");
    return app[method](...args);
  }, { method, args });
}
async function documents(page, collectionPath) {
  return page.evaluate(async ({ sdk, collectionPath }) => {
    const app = await import("/turncue.js");
    const { getDocs, collection } = await import(sdk);
    const snapshot = await getDocs(collection(app.db, collectionPath));
    return snapshot.docs.map(s => ({ id: s.id, ...s.data() }));
  }, { sdk, collectionPath });
}
async function rejectOperation(page, method, args, pattern) {
  await assert.rejects(operation(page, method, ...args), pattern);
}
async function expectDenied(page, collectionPath, fields, remove = false) {
  const outcome = await page.evaluate(async ({ sdk, collectionPath, fields, remove }) => {
    const { db } = await import("/turncue.js");
    const { doc, updateDoc, deleteDoc, serverTimestamp } = await import(sdk);
    for (const key of Object.keys(fields)) if (fields[key] === "__timestamp") fields[key] = serverTimestamp();
    try {
      if (remove) await deleteDoc(doc(db, collectionPath));
      else await updateDoc(doc(db, collectionPath), fields);
      return "allowed";
    } catch (error) { return error.code; }
  }, { sdk, collectionPath, fields, remove });
  assert.equal(outcome, "permission-denied", collectionPath);
}
async function waitText(page, id, text) {
  await page.waitForFunction(({ id, text }) => document.getElementById(id)?.textContent.includes(text), { id, text }, { timeout: 20000 });
}
async function seed(documentPath, values) {
  const fields = {};
  for (const [key, value] of Object.entries(values)) {
    fields[key] = value === null ? { nullValue: null } : typeof value === "number" ? { integerValue: value } :
      value?.timestamp ? { timestampValue: value.timestamp } : { stringValue: value };
  }
  const result = await fetch(api + "/" + documentPath, { method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
  assert(result.ok, await result.text());
}
try {
  const manager = await pageAt("business.html");
  await waitText(manager, "sessionStatus", "Queue session ready");
  // Opening another manager at once must retain one operational session.
  const manager2 = await pageAt("business.html");
  await waitText(manager2, "sessionStatus", "Queue session ready");
  const sessions = await documents(manager, "sessions");
  assert.equal(sessions.length, 1);
  const sessionId = sessions[0].id;
  passed("manager initialization preserves one session");
  for (const [name, role] of [["Maria Santos", "staff"], ["John Reyes", "manager"]]) {
    await manager.locator("#staffName").fill(name);
    await manager.locator("#staffRole").selectOption(role);
    await manager.locator("#staffForm button").click();
    await waitText(manager, "message", "Registered " + name);
  }
  for (const name of ["Window 1", "Window 2"]) {
    await manager.locator("#windowName").fill(name);
    await manager.locator("#windowForm button").click();
    await waitText(manager, "message", "Window added.");
  }
  const staff = (await documents(manager, "staff")).sort((a, b) => a.name.localeCompare(b.name));
  const maria = staff.find(p => p.name === "Maria Santos"), john = staff.find(p => p.name === "John Reyes");
  const windows = (await documents(manager, "windows")).sort((a, b) => a.name.localeCompare(b.name));
  const [w1, w2] = windows;
  assert.notEqual(maria.id, maria.staffCode);
  assert.equal((await documents(manager, "staffCodes")).length, 2);
  passed("manager forms register staff/manager with reserved IDs and configure windows");
  const mariaPage = await pageAt("staff.html", { width: 390, height: 844 });
  const johnPage = await pageAt("staff.html", { width: 390, height: 844 });
  for (const [page, person] of [[mariaPage, maria], [johnPage, john]]) {
    await page.locator("#staffCode").fill(person.staffCode.toLowerCase());
    await page.locator("#entryForm button").click();
    await waitText(page, "confirmName", "Are you " + person.name + "?");
    await page.locator("#confirmButton").click();
    await waitText(page, "message", "Staff record confirmed.");
  }
  passed("Staff ID and explicit name confirmation UI");

  const race = await Promise.allSettled([
    operation(mariaPage, "startShift", maria.id, w1.id),
    operation(johnPage, "startShift", john.id, w1.id)
  ]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
  let current = (await documents(manager, "windows")).find(w => w.id === w1.id);
  await operation(manager, "changeWindowState", w1.id, current.currentShiftId, "end", "manager");
  passed("two staff racing for one window yield exactly one owner");

  const doubleStaff = await Promise.allSettled([
    operation(mariaPage, "startShift", maria.id, w1.id),
    operation(manager2, "startShift", maria.id, w2.id)
  ]);
  assert.equal(doubleStaff.filter(r => r.status === "fulfilled").length, 1);
  current = (await documents(manager, "windows")).find(w => w.currentStaffId === maria.id);
  await operation(manager, "changeWindowState", current.id, current.currentShiftId, "end", "manager");
  passed("one staff member racing for two windows gets only one assignment");

  for (const [page, window] of [[mariaPage, w1], [johnPage, w2]]) {
    await page.getByRole("button", { name: "START SHIFT", exact: true }).click();
    await page.locator("#windowChoice").selectOption(window.id);
    await page.getByRole("button", { name: "START AT SELECTED WINDOW" }).click();
    await waitText(page, "message", "Shift started.");
  }
  const assigned = await documents(manager, "windows");
  const mw = assigned.find(w => w.id === w1.id), jw = assigned.find(w => w.id === w2.id);
  await rejectOperation(manager, "setStaffActive", [maria.id, false], /End this staff/);
  await rejectOperation(manager, "saveWindow", [w1.id, "Renamed", false], /End the shift/);
  passed("explicit window choice, manager working as staff, and assigned-record safeguards");

  const customers = await Promise.all([pageAt("index.html"), pageAt("index.html"), pageAt("index.html")]);
  for (const page of customers) {
    await page.locator("#joinButton").click();
    await page.waitForFunction(() => document.getElementById("queueScreen").style.display === "block" || document.getElementById("errorMessage").textContent);
    assert.equal(await page.locator("#errorMessage").textContent(), "", "Customer join error");
  }
  let entries = await documents(manager, "sessions/" + sessionId + "/entries");
  assert.deepEqual(entries.map(e => e.ticketNumber).sort(), [101, 102, 103]);
  const saved = await customers[0].evaluate(() => localStorage.getItem("turncue_active_entry"));
  await customers[0].reload();
  await customers[0].locator("#queueScreen").waitFor({ state: "visible" });
  assert.equal(await customers[0].evaluate(() => localStorage.getItem("turncue_active_entry")), saved);
  assert.equal((await documents(manager, "sessions/" + sessionId + "/entries")).length, 3);
  passed("Batch 1 unique sequential tickets, positions, and same-device recovery");

  // Force both callers to fetch A101 before either starts its transaction.
  const firstCandidates = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let barrierActive = true;
  for (const page of [mariaPage, johnPage]) await page.exposeFunction("__candidateSelected", async id => {
    if (!barrierActive) return;
    firstCandidates.push(id);
    if (firstCandidates.length === 2) { barrierActive = false; release(); }
    await gate;
  });
  const calls = await Promise.all([
    operation(mariaPage, "callNext", w1.id, mw.currentShiftId, sessionId),
    operation(johnPage, "callNext", w2.id, jw.currentShiftId, sessionId)
  ]);
  assert.equal(firstCandidates.length, 2);
  assert.equal(firstCandidates[0], firstCandidates[1]);
  assert.deepEqual(calls.sort(), ["A101", "A102"]);
  entries = await documents(manager, "sessions/" + sessionId + "/entries");
  const called = entries.filter(e => e.status === "called");
  assert.equal(new Set(called.map(e => e.calledWindowId)).size, 2);
  for (const page of customers) {
    const marker = JSON.parse(await page.evaluate(() => localStorage.getItem("turncue_active_entry")));
    const entry = entries.find(e => e.id === marker.entryId);
    if (entry.status === "called") await waitText(page, "calledDestination", "Please return to " + entry.calledWindowLabel + ".");
  }
  passed("forced same-candidate race retries to next ticket; unique calls and correct customer destinations");
  await rejectOperation(mariaPage, "callNext", [w1.id, mw.currentShiftId, sessionId], /Complete the current/);
  await rejectOperation(mariaPage, "changeWindowState", [w1.id, mw.currentShiftId, "end"], /Complete the called/);
  const mariaEntry = called.find(e => e.calledWindowId === w1.id);
  const johnEntry = called.find(e => e.calledWindowId === w2.id);
  await expectDenied(manager, "windows/" + w1.id, { currentEntryId: null, currentSessionId: null, currentTicketLabel: null, updatedAt: "__timestamp" });
  await expectDenied(manager, "sessions/" + sessionId + "/entries/" + mariaEntry.id, { status: "completed", completedAt: "__timestamp" });
  const waitingEntry = entries.find(e => e.status === "waiting");
  await expectDenied(manager, "sessions/" + sessionId + "/entries/" + waitingEntry.id, { status: "called", calledAt: "__timestamp" });
  passed("unresolved-customer safeguards and rules reject partial release/completion/old unassigned calls");

  await operation(mariaPage, "changeWindowState", w1.id, mw.currentShiftId, "pause");
  await waitText(mariaPage, "assignment", "paused");
  await rejectOperation(mariaPage, "callNext", [w1.id, mw.currentShiftId, sessionId], /Resume this window/);
  await operation(mariaPage, "completeCustomer", sessionId, mariaEntry.id, w1.id, mw.currentShiftId);
  current = (await documents(manager, "windows")).find(w => w.id === w1.id);
  assert.equal(current.state, "paused");
  assert.equal(current.currentEntryId, null);
  await operation(manager, "changeWindowState", w1.id, mw.currentShiftId, "resume", "manager");
  await waitText(mariaPage, "assignment", "active");
  const completes = await Promise.allSettled([
    operation(johnPage, "completeCustomer", sessionId, johnEntry.id, w2.id, jw.currentShiftId),
    operation(manager, "completeCustomer", sessionId, johnEntry.id, w2.id, jw.currentShiftId, "manager")
  ]);
  assert.equal(completes.filter(r => r.status === "fulfilled").length, 1);
  for (const page of customers) {
    const marker = await page.evaluate(() => localStorage.getItem("turncue_active_entry"));
    if (marker && JSON.parse(marker).entryId === waitingEntry.id) {
      page.once("dialog", dialog => dialog.accept());
      await page.locator("#leaveButton").click();
      await page.locator("#cancelledScreen").waitFor({ state: "visible" });
    } else {
      await page.locator("#completedScreen").waitFor({ state: "visible" });
      assert.notEqual(await page.locator("#waitTime").textContent(), "--");
      assert.notEqual(await page.locator("#serviceTime").textContent(), "--");
      assert.notEqual(await page.locator("#totalTime").textContent(), "--");
    }
  }
  passed("pause retains ownership, paused completion, explicit resume, completion race, cancellation and timing");

  await seed("sessions/" + sessionId + "/entries/legacy-call", {
    ...scope, sessionId, ticketNumber: 99, ticketLabel: "A99", status: "called",
    joinedAt: { timestamp: new Date(Date.now() - 120000).toISOString() },
    calledAt: { timestamp: new Date(Date.now() - 60000).toISOString() }, completedAt: null, cancelledAt: null
  });
  await operation(manager, "completeCustomer", sessionId, "legacy-call", null, null, "manager");
  await seed("queue/historical", { status: "waiting" });
  await expectDenied(manager, "queue/historical", { status: "called" });
  await expectDenied(manager, "queue/historical", {}, true);
  passed("legacy Batch 1 called completion and historical prototype write/delete protection");

  await operation(mariaPage, "changeWindowState", w1.id, mw.currentShiftId, "end");
  await operation(manager, "setStaffActive", maria.id, false);
  await rejectOperation(mariaPage, "findStaff", [maria.staffCode], /inactive/);
  await operation(manager, "setStaffActive", maria.id, true);
  await operation(manager, "saveWindow", w1.id, "Window 1", false);
  await rejectOperation(mariaPage, "startShift", [maria.id, w1.id], /no longer available/);
  await operation(manager, "saveWindow", w1.id, "Window 1", true);
  const replacement = await operation(mariaPage, "startShift", maria.id, w1.id);
  await rejectOperation(manager2, "changeWindowState", [w1.id, mw.currentShiftId, "pause", "manager"], /assignment has changed/);
  const shifts = await documents(manager, "shifts");
  const ended = shifts.find(s => s.id === mw.currentShiftId);
  const restarted = shifts.find(s => s.id === replacement);
  const millis = timestamp => timestamp.seconds * 1000 + timestamp.nanoseconds / 1e6;
  assert(millis(restarted.startedAt) > millis(ended.endedAt));
  const events = await documents(manager, "windowEvents");
  for (const type of ["shift_started", "shift_ended", "window_paused", "window_resumed", "customer_called", "customer_completed"]) assert(events.some(e => e.type === type), type);
  await expectDenied(manager, "windowEvents/" + events[0].id, { source: "manager" });
  await expectDenied(manager, "windowEvents/" + events[0].id, {}, true);
  await expectDenied(manager, "staff/" + maria.id, {}, true);
  await expectDenied(manager, "shifts/" + replacement, {}, true);
  passed("inactive/reactivated records, disabled windows, stale-shift protection, exact gaps and immutable history");

  await manager.screenshot({ path: path.join(assets, "manager.png"), fullPage: true });
  await mariaPage.screenshot({ path: path.join(assets, "staff.png"), fullPage: true });
  await customers[0].screenshot({ path: path.join(assets, "customer.png"), fullPage: true });
  assert.deepEqual(errors, [], "uncaught browser errors");
  passed("desktop/mobile rendering captured with no uncaught browser errors");
  console.log("SUCCESS: " + checks + " integration groups passed. Only loopback demo data was used.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
