import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project = testProject("pending-join");
await compileRules(project);
const server = await startBrowserServer(project), origin = "http://127.0.0.1:" + server.address().port;
const emulator = "http://127.0.0.1:8787", errors = [], external = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if ([origin, emulator].includes(url.origin)) return route.continue();
    if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) return route.fulfill({ path: path.join(process.env.TURNCUE_TEST_ASSETS, path.basename(url.pathname)), contentType: "text/javascript" });
    if (!(url.origin === "https://www.google.com" && url.pathname === "/images/cleardot.gif")) external.push(url.href);
    return route.abort();
  });
  // Real transaction underneath; only its acknowledgement is interrupted.
  await context.route(origin + "/join-entry.js", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace("export async function joinEntry(", "async function originalJoinEntry(") + `
export async function joinEntry(db, request) {
  if (globalThis.customerJoinMode) {
    const { environment } = await import('/firebase-client.js');
    const pending = JSON.parse(localStorage.getItem(environment.storagePrefix + ':pending_join'));
    if (pending?.entryId !== request.entryId) throw new Error('Pending identity missing before submission');
    globalThis.submittedJoin = request;
    if (globalThis.customerJoinMode === 'missing') throw new Error('Simulated precommit interruption');
  }
  const result = await originalJoinEntry(db, request);
  if (globalThis.customerJoinMode === 'held') { globalThis.joinCommitted = true; await new Promise(resolve => { globalThis.releaseJoin = resolve; }); }
  if (['lost','held'].includes(globalThis.customerJoinMode)) throw new Error('Simulated lost acknowledgement');
  return result;
}`;
    await route.fulfill({ response, body });
  });
  await context.addInitScript(() => {
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(key, value) {
      if (globalThis.failPendingStorage && key.endsWith(":pending_join")) throw new Error("Simulated storage failure");
      return set.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key) {
      if (key.endsWith(":pending_join") && this.getItem(key)) {
        globalThis.pendingRemovalHadActive = Boolean(this.getItem(key.replace(":pending_join", ":active_entry")));
      }
      return remove.call(this, key);
    };
  });
  const manager = await context.newPage();
  let customer = await context.newPage();
  const track = page => page.on("pageerror", e => errors.push(e.message)); track(manager); track(customer);
  await manager.goto(origin + "/staff.html");
  const fixture = await manager.evaluate(async () => {
    const app = await import("/turncue.js");
    const sid = await app.initializeTurnCue(), wid = await app.saveWindow(null, "Pending Test", true), code = await app.registerStaff("Pending Staff", "staff");
    return { sid, wid, shift: await app.startShift((await app.findStaff(code)).id, wid), businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID };
  });
  const state = () => manager.evaluate(async sid => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const entries = await sdk.getDocsFromServer(sdk.collection(app.db, "sessions", sid, "entries"));
    return JSON.parse(JSON.stringify({ counter: (await sdk.getDocFromServer(sdk.doc(app.db, "sessions", sid))).data().nextTicketNumber, entries: entries.docs.map(d => ({ id: d.id, ...d.data() })) }));
  }, fixture.sid);
  const markers = () => customer.evaluate(async () => {
    const { environment } = await import("/firebase-client.js"), prefix = environment.storagePrefix;
    return { pending: JSON.parse(localStorage.getItem(prefix + ":pending_join")), active: JSON.parse(localStorage.getItem(prefix + ":active_entry")) };
  });
  async function fresh(mode = "lost") {
    await customer.goto(origin + "/index.html");
    await customer.evaluate(async () => {
      const { environment } = await import("/firebase-client.js");
      localStorage.removeItem(environment.storagePrefix + ":active_entry");
    });
    await customer.reload(); await expect(customer.locator("#joinButton")).toBeEnabled();
    await customer.evaluate(mode => { globalThis.customerJoinMode = mode; }, mode);
  }
  await fresh(); const initial = await state();
  await customer.locator("#joinButton").evaluate(button => { button.click(); button.click(); });
  await expect(customer.locator("#waitingMessage")).toBeVisible();
  let marker = await markers(), snapshot = await state();
  assert.equal(marker.pending, null); assert(marker.active.entryId);
  assert.equal(await customer.evaluate(() => pendingRemovalHadActive), true);
  assert.equal(snapshot.counter, initial.counter + 1); assert.equal(snapshot.entries.length, initial.entries.length + 1);
  const original = snapshot.entries.find(e => e.id === marker.active.entryId);
  await manager.evaluate(async ({ fixture, id }) => {
    const app = await import("/turncue.js"), join = await import("/join-entry.js");
    await join.joinEntry(app.db, { ...fixture, sessionId: fixture.sid, entryId: id });
  }, { fixture, id: marker.active.entryId });
  assert.deepEqual(await state(), snapshot);
  await customer.reload(); await expect(customer.locator("#waitingMessage")).toBeVisible();
  console.log("PASS pending-before-submission, lost committed acknowledgement, active-before-pending cleanup, double-click, same-ID idempotency and normal reload");
  await fresh("held"); const beforeHeld = await state();
  await customer.locator("#joinButton").click(); await customer.waitForFunction(() => globalThis.joinCommitted);
  const held = (await markers()).pending;
  const second = await context.newPage(); track(second); await second.goto(origin + "/index.html");
  await expect(second.locator("#joinButton")).toBeDisabled();
  await customer.evaluate(() => releaseJoin());
  await expect(customer.locator("#waitingMessage")).toBeVisible(); await expect(second.locator("#waitingMessage")).toBeVisible();
  assert.equal((await state()).counter, beforeHeld.counter + 1);
  assert.equal((await markers()).active.entryId, held.entryId);
  await second.close();
  // Reload destroys the held acknowledgement, then startup reads the committed ticket.
  await fresh("held"); await customer.locator("#joinButton").click(); await customer.waitForFunction(() => globalThis.joinCommitted);
  const refreshPending = (await markers()).pending;
  await customer.reload(); await expect(customer.locator("#waitingMessage")).toBeVisible();
  assert.equal((await markers()).active.entryId, refreshPending.entryId);
  console.log("PASS two-tab shared identity and refresh during held acknowledgement");
  await fresh("missing"); const beforeMissing = await state();
  await customer.locator("#joinButton").click(); await expect(customer.locator("#retryRecoveryButton")).toBeVisible();
  const missing = (await markers()).pending;
  await expect(customer.locator("#joinButton")).toBeDisabled(); assert.deepEqual(await state(), beforeMissing);
  await customer.close(); customer = await context.newPage(); track(customer);
  await customer.goto(origin + "/index.html"); await expect(customer.locator("#retryRecoveryButton")).toBeVisible();
  await expect(customer.locator("#recoveryFeedback")).toHaveText("No ticket was found yet. Try Again retries your original JOIN without creating another identity.");
  assert.deepEqual((await markers()).pending, missing);
  assert.deepEqual(await state(), beforeMissing);
  await customer.locator("#retryRecoveryButton").click(); await expect(customer.locator("#waitingMessage")).toBeVisible();
  assert.equal((await markers()).active.entryId, missing.entryId); assert.equal((await state()).counter, beforeMissing.counter + 1);
  assert.equal((await markers()).pending, null);
  assert.equal(await customer.evaluate(() => pendingRemovalHadActive), true);
  assert.equal((await state()).entries.find(e => e.id === missing.entryId).status, "waiting");
  await fresh(""); await customer.evaluate(() => { globalThis.failPendingStorage = true; });
  const beforeStorage = await state(); await customer.locator("#joinButton").click();
  await expect(customer.locator("#errorMessage")).toContainText("couldn't save this JOIN safely"); assert.deepEqual(await state(), beforeStorage);
  await customer.evaluate(() => { globalThis.failPendingStorage = false; });
  await customer.locator("#joinButton").click(); await expect(customer.locator("#waitingMessage")).toBeVisible();
  console.log("PASS missing retains original identity, close/reopen, explicit same-ID retry, storage failure before submission and normal JOIN");
  await fresh("missing"); await customer.locator("#joinButton").click(); await expect(customer.locator("#retryRecoveryButton")).toBeVisible();
  const deniedPending = (await markers()).pending;
  const rules = fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), start = rules.indexOf("match /entries/{entryId}");
  const deny = rules.slice(0, start) + rules.slice(start).replace("allow read: if true;", "allow read: if false;");
  const response = await fetch(`${emulator}/emulator/v1/projects/${project}:securityRules`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content: deny }] } }) }); assert(response.ok);
  await customer.reload(); await expect(customer.locator("#retryRecoveryButton")).toBeVisible(); await expect(customer.locator("#joinButton")).toBeDisabled();
  await expect(customer.locator("#recoveryFeedback")).toContainText(/permission|insufficient|false for 'get' @ L\d+/i);
  assert.deepEqual((await markers()).pending, deniedPending);
  await customer.evaluate(async () => {
    const { db } = await import("/firebase-client.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    await sdk.disableNetwork(db);
  });
  await customer.locator("#retryRecoveryButton").click();
  await expect(customer.locator("#recoveryFeedback")).toContainText(/offline|unavailable/i);
  assert.deepEqual((await markers()).pending, deniedPending); await expect(customer.locator("#joinButton")).toBeDisabled();
  await customer.evaluate(async () => {
    const { db } = await import("/firebase-client.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    await sdk.enableNetwork(db);
  });
  await compileRules(project);
  await manager.evaluate(async fixture => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    await sdk.setDoc(sdk.doc(app.db, "sessions", "new-session"), { businessId: fixture.businessId, locationId: fixture.locationId, queueId: fixture.queueId, status: "open", ticketPrefix: "B", nextTicketNumber: 101, openedAt: sdk.serverTimestamp(), closedAt: null });
    await sdk.updateDoc(sdk.doc(app.db, "queues", app.QUEUE_ID), { currentSessionId: "new-session" });
  }, fixture);
  await customer.locator("#retryRecoveryButton").click(); await expect(customer.locator("#resolvePreviousJoin")).toBeVisible();
  assert.deepEqual((await markers()).pending, deniedPending); assert.equal((await markers()).active, null);
  await customer.locator("#resolvePreviousJoin").click(); await expect(customer.locator("#joinButton")).toBeEnabled(); assert.equal((await markers()).pending, null);
  await manager.evaluate(async fixture => {
    const app = await import("/turncue.js"), join = await import("/join-entry.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    await sdk.updateDoc(sdk.doc(app.db, "queues", app.QUEUE_ID), { currentSessionId: fixture.sid });
    const request = join.createAssistedRequest({ ...fixture, sessionId: fixture.sid });
    const [called, assisted] = await Promise.all([app.callNext(fixture.wid, fixture.shift, fixture.sid), join.issueAssistedEntry(app.db, request), join.joinEntry(app.db, { ...fixture, sessionId: fixture.sid, entryId: "normal-racing" })]);
    if (!called || assisted.entryId !== request.entryId || assisted.recoveryCode !== request.recoveryCode) throw new Error("Mixed CALL/assisted issuance failed");
  }, fixture);
  const final = await state(), preserved = final.entries.find(e => e.id === original.id);
  assert.deepEqual(preserved.joinedAt, original.joinedAt); assert.equal(preserved.queueOrder, original.queueOrder);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS persistent read failure, session isolation/safe deliberate resolution, assisted/CALL contention and unchanged joinedAt/order; no unexpected errors/traffic");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
