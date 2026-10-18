import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project = testProject("connectivity");
await compileRules(project);
const server = await startBrowserServer(project), origin = "http://127.0.0.1:" + server.address().port;
const emulator = "http://127.0.0.1:8787", errors = [], external = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  let recoveryGate = null;
  async function newContext() {
    const context = await browser.newContext();
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      const gate = recoveryGate;
      if (gate && !gate.held && route.request().frame().page() === gate.page
        && url.origin === emulator && url.pathname.endsWith("/google.firestore.v1.Firestore/Listen/channel")
        && route.request().method() === "POST") {
        const body = decodeURIComponent(route.request().postData() || "");
        if (body.includes("addTarget") && body.includes(gate.ticketPath)) {
          gate.held = true;
          await gate.release;
          return route.abort("failed");
        }
      }
      if ([origin, emulator].includes(url.origin)) return route.continue();
      if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) {
        let body = fs.readFileSync(path.join(process.env.TURNCUE_TEST_ASSETS, path.basename(url.pathname)), "utf8");
        if (url.pathname.endsWith("firebase-firestore.js")) {
          const exportStart = body.lastIndexOf("export{");
          const exports = body.slice(exportStart);
          assert(exportStart >= 0 && /([,{])onSnapshot(?=[,}])/.test(exports), "SDK onSnapshot export required for subscription counting");
          body = body.slice(0, exportStart) + exports.replace(/([,{])onSnapshot(?=[,}])/, "$1onSnapshot as originalOnSnapshot") + `\nconst originalOnSnapshot = onSnapshot; export function countedOnSnapshot(...args) { globalThis.subscriptionStarts = (globalThis.subscriptionStarts || 0) + 1; const stop = originalOnSnapshot(...args); return () => { globalThis.subscriptionStops = (globalThis.subscriptionStops || 0) + 1; stop(); }; } export { countedOnSnapshot as onSnapshot };`;
        }
        return route.fulfill({ body, contentType: "text/javascript" });
      }
      if (!(url.origin === "https://www.google.com" && url.pathname === "/images/cleardot.gif")) external.push(url.href);
      return route.abort();
    });
    return context;
  }
  const managerContext = await newContext(), customerContext = await newContext();
  const manager = await managerContext.newPage(), customer = await customerContext.newPage();
  for (const page of [manager, customer]) page.on("pageerror", e => errors.push(e.message));
  await manager.goto(origin + "/staff.html");
  const fixture = await manager.evaluate(async () => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const sid = await app.initializeTurnCue(), wid = await app.saveWindow(null, "Connection Test", true), code = await app.registerStaff("Connection Staff", "staff");
    const shift = await app.startShift((await app.findStaff(code)).id, wid);
    for (let i = 0; i < 3; i++) await sdk.setDoc(sdk.doc(app.db, "queues", app.QUEUE_ID, "serviceSamples", "pace-" + i), {
      businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid, entryId: "pace-" + i, windowId: wid, shiftId: shift,
      calledAt: sdk.Timestamp.fromMillis(Date.now() - 600000), completedAt: sdk.serverTimestamp(), durationSeconds: null, durationMinutes: null, cleanEligible: true, exclusionReason: null, recordedAt: sdk.serverTimestamp()
    });
    return { sid, wid, shift };
  });
  const invoke = (name, args) => manager.evaluate(async ({ name, args }) => (await import("/turncue.js"))[name](...args), { name, args });
  const state = () => manager.evaluate(async sid => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const entries = await sdk.getDocsFromServer(sdk.collection(app.db, "sessions", sid, "entries"));
    return JSON.parse(JSON.stringify({ session: (await sdk.getDocFromServer(sdk.doc(app.db, "sessions", sid))).data(), entries: entries.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => a.id.localeCompare(b.id)) }));
  }, fixture.sid);
  const notice = customer.locator("#connectionNotice");
  const saved = () => customer.evaluate(async () => {
    const { environment } = await import("/firebase-client.js");
    return JSON.parse(localStorage.getItem(environment.storagePrefix + ":active_entry"));
  });
  const sdkNetwork = enabled => customer.evaluate(async enabled => {
    const { db } = await import("/firebase-client.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    await sdk[enabled ? "enableNetwork" : "disableNetwork"](db);
  }, enabled);
  async function reconnect() {
    await sdkNetwork(true);
    await expect(notice).toHaveAttribute("data-state", "connected");
    await expect(notice).toBeHidden();
  }
  await customer.goto(origin + "/index.html");
  await expect(customer.locator("#joinButton")).toBeEnabled(); await customer.locator("#joinButton").click();
  await expect(customer.locator("#waitingMessage")).toBeVisible();
  await expect(notice).toHaveAttribute("data-state", "connected");
  const marker = await saved(), id = marker.entryId;
  const ticket = await customer.locator("#ticketNumber").textContent();
  await expect(customer.locator("#needMoreTimeButton")).toBeEnabled();
  // Wait for the pre-existing immutable first-ETA write before the baseline.
  await expect.poll(async () => Boolean((await state()).entries.find(e => e.id === id).firstNumericEtaShownAt)).toBe(true);
  const original = await state(), starts = await customer.evaluate(() => subscriptionStarts);
  await customer.locator("#needMoreTimeButton").click(); await expect(customer.locator("#needMoreTimeDialog")).toBeVisible();
  await sdkNetwork(false);
  await expect(notice).toHaveAttribute("data-state", "reconnecting");
  await expect(customer.locator("#needMoreTimeYes")).toBeDisabled();
  await expect(customer.locator("#waitingMessage")).toBeVisible();
  await expect(customer.locator("#ticketNumber")).toHaveText(ticket);
  await expect(customer.locator("#joinScreen")).toBeHidden(); assert.deepEqual(await saved(), marker);
  assert.deepEqual(await state(), original);
  await reconnect(); await expect(customer.locator("#needMoreTimeYes")).toBeEnabled();
  await customer.locator("#needMoreTimeCancel").click();
  await customer.locator("#leaveButton").click(); await expect(customer.locator("#leaveDialog")).toBeVisible();
  await sdkNetwork(false); await expect(notice).toHaveAttribute("data-state", "reconnecting");
  await expect(customer.getByRole("button", { name: "I Need to Leave", exact: true })).toBeDisabled();
  await expect(customer.locator("#leaveDialog")).toBeVisible();
  await reconnect(); await customer.getByRole("button", { name: "Keep Me in Line", exact: true }).click();
  assert.deepEqual(await state(), original);
  assert.equal(await customer.evaluate(() => subscriptionStarts), starts);
  console.log("PASS WAITING uncertainty, preserved ticket/marker, exclusive safe prompts, server-confirmed reconnect, unchanged lifecycle/order/counter and listener count");
  await invoke("callNext", [fixture.wid, fixture.shift, fixture.sid]);
  await expect(customer.locator("#imHereButton")).toBeVisible();
  const called = await state();
  await customerContext.setOffline(true);
  await expect(notice).toHaveAttribute("data-state", "stale");
  await expect(customer.locator("#calledTicket")).toHaveText(ticket);
  await expect(customer.locator("#calledDestination")).toContainText("Connection Test");
  await expect(customer.locator("#imHereButton")).toBeDisabled();
  await expect(customer.locator("#joinScreen")).toBeHidden(); assert.deepEqual(await state(), called);
  await customerContext.setOffline(false); await expect(notice).toHaveAttribute("data-state", "connected");
  await customer.locator("#imHereButton").click(); await expect(customer.locator("#calledTitle")).toHaveText("Service in progress");
  const progress = await state();
  await sdkNetwork(false); await expect(notice).toHaveAttribute("data-state", "reconnecting");
  await expect(customer.locator("#calledTicket")).toHaveText(ticket); await expect(customer.locator("#calledDestination")).toContainText("Connection Test");
  assert.deepEqual(await state(), progress); assert.deepEqual(await saved(), marker);
  await reconnect(); assert.equal(await customer.evaluate(() => subscriptionStarts), starts);
  console.log("PASS CALLED browser-offline warning/presence gate and IN_PROGRESS preservation without reconnect listener duplication");
  // A server-read failure on reload retains identifiers and never offers JOIN.
  let releaseRecovery;
  recoveryGate = { page: customer, ticketPath: `/sessions/${fixture.sid}/entries/${id}`, held: false, release: new Promise(resolve => { releaseRecovery = resolve; }) };
  await customer.reload();
  await expect.poll(() => recoveryGate.held).toBe(true);
  await expect(customer.locator("#loadingScreen")).toBeVisible();
  await expect(customer.locator("#joinButton")).toBeDisabled(); assert.deepEqual(await saved(), marker);
  await sdkNetwork(false);
  releaseRecovery(); recoveryGate = null;
  await customer.locator("#connectionRetry").click();
  await expect(customer.locator("#retryRecoveryButton")).toBeVisible();
  await expect(customer.locator("#joinButton")).toBeDisabled(); assert.deepEqual(await saved(), marker);
  await sdkNetwork(true);
  await customer.locator("#retryRecoveryButton").click();
  await expect(notice).toHaveAttribute("data-state", "connected");
  await expect(customer.locator("#calledTitle")).toBeVisible();
  await expect(customer.locator("#calledTitle")).toHaveText("Service in progress");
  assert.equal((await state()).entries.find(e => e.id === id).status, "in_progress");
  const current = progress.entries.find(e => e.id === id);
  await invoke("resolveAndContinue", [fixture.sid, id, fixture.wid, fixture.shift, current.callAttemptId, "completed", "pause"]);
  await expect(customer.locator("#completedScreen")).toBeVisible();
  await customer.reload(); await expect(customer.locator("#completedScreen")).toBeVisible();
  assert.deepEqual(await saved(), marker);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS recovery JOIN blocking, retained identifiers, terminal recovery, no unexpected traffic/errors");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
