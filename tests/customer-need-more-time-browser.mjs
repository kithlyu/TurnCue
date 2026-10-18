import assert from "node:assert/strict";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";

const project = testProject("customer-time"), assets = process.env.TURNCUE_TEST_ASSETS;
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
    if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) return route.fulfill({ path: path.join(assets, path.basename(url.pathname)), contentType: "text/javascript" });
    external.push(url.href); return route.abort();
  });
  const manager = await context.newPage(), customer = await context.newPage();
  for (const page of [manager, customer]) page.on("pageerror", error => errors.push(error.message));
  await manager.goto(origin + "/staff.html");
  const fixture = await manager.evaluate(async () => {
    const app = await import("/turncue.js");
    const sid = await app.initializeTurnCue(), wid = await app.saveWindow(null, "Customer Time", true), code = await app.registerStaff("Time Staff", "staff");
    const person = await app.findStaff(code);
    const shift = await app.startShift(person.id, wid);
    return { sid, wid, shift };
  });
  await customer.clock.install();
  await customer.goto(origin + "/index.html");
  await customer.locator("#joinButton").click();
  await expect.poll(() => customer.evaluate(async sid => {
    const { db, environment } = await import("/firebase-client.js");
    const saved = JSON.parse(localStorage.getItem(environment.storagePrefix + ":active_entry"));
    if (!saved?.entryId || saved.sessionId !== sid) return false;
    const sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const snapshot = await sdk.getDocFromServer(sdk.doc(db, "sessions", sid, "entries", saved.entryId));
    return snapshot.exists() && snapshot.data().status === "waiting"
      && document.getElementById("ticketNumber").textContent === snapshot.data().ticketLabel;
  }, fixture.sid)).toBe(true);
  await expect(customer.locator("#queueScreen")).toBeVisible();
  await expect(customer.locator("#position")).toHaveText("#1");
  const id = await customer.evaluate(async () => {
    const { environment } = await import("/firebase-client.js");
    return JSON.parse(localStorage.getItem(environment.storagePrefix + ":active_entry")).entryId;
  });
  const read = () => manager.evaluate(async ({ sid, id }) => {
    const { db } = await import("/firebase-client.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const t = (await sdk.getDocFromServer(sdk.doc(db, "sessions", sid, "entries", id))).data();
    return { status: t.status, ticketNumber: t.ticketNumber, joinedAt: t.joinedAt.toMillis(), queueOrder: t.queueOrder ?? null, used: t.customerNeedMoreTimeAt?.toMillis() ?? null };
  }, { sid: fixture.sid, id });
  const original = await read();
  const button = customer.locator("#needMoreTimeButton"), dialog = customer.locator("#needMoreTimeDialog");
  await expect(button).toBeHidden();
  await manager.evaluate(async ({ sid, wid, shift }) => {
    const app = await import("/turncue.js"), { joinEntry } = await import("/join-entry.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    for (let i = 0; i < 3; i++) await sdk.setDoc(sdk.doc(app.db, "queues", app.QUEUE_ID, "serviceSamples", "time-" + i), {
      businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid, entryId: "time-" + i, windowId: wid, shiftId: shift,
      calledAt: sdk.Timestamp.fromMillis(Date.now() - 600000), completedAt: sdk.serverTimestamp(), durationSeconds: null, durationMinutes: null, cleanEligible: true, exclusionReason: null, recordedAt: sdk.serverTimestamp()
    });
    for (let i = 0; i < 3; i++) await joinEntry(app.db, { businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid, entryId: "behind-" + i });
  }, fixture);
  await expect(button).toBeEnabled(); await expect(button).toBeVisible();
  const open = async () => {
    await button.click(); await expect(dialog).toBeVisible();
    await expect(customer.locator("#needMoreTimeCountdown")).toHaveText(/Confirm in (?:20|19) seconds/);
    const explanation = await customer.locator("#needMoreTimeExplanation").textContent();
    const target = Number(explanation.match(/~(\d+) more minutes/)?.[1]);
    assert(Number.isFinite(target) && target >= 10, "Displayed target must be at least 10 minutes");
    assert.deepEqual(await read(), original);
  };
  await open();
  await customer.locator("#needMoreTimeCancel").click(); await expect(dialog).toBeHidden();
  assert.deepEqual(await read(), original);
  console.log("PASS numeric eligibility, backend target/countdown, proposal-only opening and cancellation");

  await open();
  // Advance only the customer's confirmation clock; no queue-state sleeps.
  await customer.clock.fastForward(21000);
  await expect(dialog).toBeHidden(); await expect(customer.locator("#needMoreTimeFeedback")).toContainText("expired");
  assert.deepEqual(await read(), original);
  await customer.clock.setSystemTime(new Date());
  await customer.reload(); await expect(button).toBeVisible();
  await open(); await customer.reload(); await expect(dialog).toBeHidden(); await expect(button).toBeVisible();
  assert.deepEqual(await read(), original);
  console.log("PASS timeout and refresh leave position and allowance unchanged");

  await open();
  await manager.evaluate(async ({ wid, shift }) => (await import("/turncue.js")).changeWindowState(wid, shift, "pause"), fixture);
  await expect(button).toBeHidden();
  await customer.locator("#needMoreTimeYes").click(); await expect(dialog).toBeHidden();
  await expect(customer.locator("#needMoreTimeFeedback")).toContainText("allowance have not changed");
  assert.deepEqual(await read(), original);
  await manager.evaluate(async ({ wid, shift }) => (await import("/turncue.js")).changeWindowState(wid, shift, "resume"), fixture);
  await expect(button).toBeVisible();
  await open();
  await customer.locator("#needMoreTimeYes").click(); await expect(dialog).toBeHidden();
  await expect(button).toBeHidden(); await expect(customer.locator("#position")).toHaveText("#2");
  await expect(customer.locator("#etaStatus")).toContainText("About");
  const moved = await read();
  assert(moved.used); assert(moved.queueOrder > original.ticketNumber);
  assert.equal(moved.ticketNumber, original.ticketNumber); assert.equal(moved.joinedAt, original.joinedAt);
  console.log("PASS ETA loss preserves state; confirmation updates position/ETA and consumes only the customer allowance");

  await manager.evaluate(async ({ sid, wid, shift }) => {
    const app = await import("/turncue.js");
    await app.callNext(wid, shift, sid);
    const sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const w = (await sdk.getDocFromServer(sdk.doc(app.db, "windows", wid))).data();
    await app.resolveAndContinue(sid, w.currentEntryId, wid, shift, w.currentCallAttemptId, "completed", "next");
  }, fixture);
  await expect(customer.locator("#imHereButton")).toBeVisible(); await expect(button).toBeHidden();
  const calledAt = await customer.evaluate(async ({ sid, id }) => {
    const { db } = await import("/firebase-client.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    return (await sdk.getDocFromServer(sdk.doc(db, "sessions", sid, "entries", id))).data().calledAt.toMillis();
  }, { sid: fixture.sid, id });
  await customer.locator("#imHereButton").click(); await expect(customer.locator("#calledTitle")).toHaveText("Service in progress");
  await manager.evaluate(async ({ sid, wid, shift, id, calledAt }) => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const t = (await sdk.getDocFromServer(sdk.doc(app.db, "sessions", sid, "entries", id))).data();
    if (t.calledAt.toMillis() !== calledAt) throw new Error("Presence reset calledAt");
    await app.resolveAndContinue(sid, id, wid, shift, t.callAttemptId, "completed", "pause");
  }, { ...fixture, id, calledAt });
  await expect(customer.locator("#completedScreen")).toBeVisible();
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS existing called/presence/completion lifecycle after customer repositioning");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
