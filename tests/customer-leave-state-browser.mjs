import assert from "node:assert/strict";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project = testProject("leave-ui");
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
    external.push(url.href); return route.abort();
  });
  const manager = await context.newPage(), customer = await context.newPage();
  for (const page of [manager, customer]) page.on("pageerror", e => errors.push(e.message));
  await manager.goto(origin + "/staff.html");
  const fixture = await manager.evaluate(async () => {
    const app = await import("/turncue.js");
    const sid = await app.initializeTurnCue(), wid = await app.saveWindow(null, "Leave Test", true), code = await app.registerStaff("Leave Staff", "staff");
    const shift = await app.startShift((await app.findStaff(code)).id, wid);
    return { sid, wid, shift };
  });
  const invoke = (name, args) => manager.evaluate(async ({ name, args }) => (await import("/turncue.js"))[name](...args), { name, args });
  let id, label;
  const read = () => manager.evaluate(async ({ sid, id }) => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const t = (await sdk.getDocFromServer(sdk.doc(app.db, "sessions", sid, "entries", id))).data();
    return { ...t, joinedAt: t.joinedAt.toMillis(), calledAt: t.calledAt?.toMillis() ?? null };
  }, { sid: fixture.sid, id });
  async function join() {
    await customer.goto(origin + "/index.html");
    await customer.locator("#joinButton").click();
    await expect.poll(() => customer.evaluate(async () => {
      const { environment } = await import("/firebase-client.js");
      return JSON.parse(localStorage.getItem(environment.storagePrefix + ":active_entry"))?.entryId ?? null;
    })).not.toBeNull();
    id = await customer.evaluate(async () => {
      const { environment } = await import("/firebase-client.js");
      return JSON.parse(localStorage.getItem(environment.storagePrefix + ":active_entry")).entryId;
    });
    const t = await read(); label = t.ticketLabel;
    await expect(customer.locator("#queueScreen")).toBeVisible();
    await expect(customer.locator("#ticketNumber")).toHaveText(label);
    assert.equal(t.status, "waiting");
  }
  const leave = customer.locator("#leaveDialog"), nmt = customer.locator("#needMoreTimeDialog");
  await join(); const original = await read();
  await customer.locator("#leaveButton").click(); await expect(leave).toBeVisible();
  await expect(leave).toContainText("you can rejoin later");
  await expect(customer.locator("#leaveNeedMoreTimeButton")).toBeHidden();
  await customer.getByRole("button", { name: "Keep Me in Line", exact: true }).click();
  await expect(leave).toBeHidden(); assert.deepEqual(await read(), original);
  await customer.locator("#leaveButton").click();
  await customer.getByRole("button", { name: "I Need to Leave", exact: true }).click();
  await expect(customer.locator("#cancelledScreen")).toBeVisible();
  await expect(customer.locator("#exitTicket")).toContainText(label);
  assert.equal((await read()).status, "left_queue");
  await customer.locator("#cancelledHomeButton").click();
  console.log("PASS leave confirmation, keep-in-line, transactional exit and ticket identity");

  await join();
  await manager.evaluate(async ({ sid, wid, shift }) => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js"), { joinEntry } = await import("/join-entry.js");
    for (let i = 0; i < 3; i++) await sdk.setDoc(sdk.doc(app.db, "queues", app.QUEUE_ID, "serviceSamples", "leave-" + i), {
      businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid, entryId: "leave-" + i, windowId: wid, shiftId: shift,
      calledAt: sdk.Timestamp.fromMillis(Date.now() - 600000), completedAt: sdk.serverTimestamp(), durationSeconds: null, durationMinutes: null, cleanEligible: true, exclusionReason: null, recordedAt: sdk.serverTimestamp()
    });
    for (let i = 0; i < 2; i++) await joinEntry(app.db, { businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid, entryId: "behind-" + i });
  }, fixture);
  await expect(customer.locator("#getReady")).toBeVisible();
  await expect(customer.locator("#needMoreTimeButton")).toBeVisible();
  await invoke("changeWindowState", [fixture.wid, fixture.shift, "pause"]);
  await expect(customer.locator("#getReady")).toBeHidden();
  await invoke("changeWindowState", [fixture.wid, fixture.shift, "resume"]);
  await expect(customer.locator("#getReady")).toBeVisible();
  await customer.locator("#leaveButton").click();
  await customer.locator("#leaveNeedMoreTimeButton").click();
  await expect(leave).toBeHidden(); await expect(nmt).toBeVisible();
  await expect(customer.locator("#needMoreTimeCountdown")).toHaveText(/Confirm in \d+ seconds/);
  await customer.locator("#needMoreTimeYes").click(); await expect(nmt).toBeHidden();
  await expect(customer.locator("#position")).toHaveText("#2");
  await expect(customer.locator("#getReady")).toBeHidden();
  await expect(customer.locator("#needMoreTimeButton")).toBeHidden();
  const deferred = await read(); assert(deferred.customerNeedMoreTimeAt);
  // Remove the ticket now ahead so CALL NEXT races the open leave decision.
  await invoke("transitionTicket", [fixture.sid, "behind-0", "left_queue"]);
  await expect(customer.locator("#position")).toHaveText("#1");
  await customer.locator("#leaveButton").click(); await expect(leave).toBeVisible();
  await invoke("callNext", [fixture.wid, fixture.shift, fixture.sid]);
  await expect(customer.locator("#imHereButton")).toBeVisible(); await expect(leave).toBeHidden();
  const called = await read(); assert(called.callAttemptId);
  await assert.rejects(invoke("transitionTicket", [fixture.sid, id, "left_queue"]));
  assert.equal((await read()).status, "called");
  await customer.locator("#imHereButton").click();
  await expect(customer.locator("#calledTitle")).toHaveText("Service in progress");
  assert.equal((await read()).calledAt, called.calledAt);
  await assert.rejects(invoke("transitionTicket", [fixture.sid, id, "opted_out", fixture.wid, fixture.shift, "staff", "old-attempt"]));
  await invoke("resolveAndContinue", [fixture.sid, id, fixture.wid, fixture.shift, called.callAttemptId, "completed", "pause"]);
  await expect(customer.locator("#completedScreen")).toBeVisible();
  await expect(customer.locator("#completedTicket")).toContainText(label);
  await customer.locator("#backHomeButton").click();
  console.log("PASS exclusive alternative, live readiness, CALL/leave race, stale attempt rejection and completion identity");

  // Resolve remaining waiting fixture, then check both other exit presentations.
  await invoke("transitionTicket", [fixture.sid, "behind-1", "left_queue"]);
  await invoke("changeWindowState", [fixture.wid, fixture.shift, "resume"]);
  for (const outcome of ["no_show", "opted_out"]) {
    await join(); await invoke("callNext", [fixture.wid, fixture.shift, fixture.sid]);
    await expect(customer.locator("#imHereButton")).toBeVisible();
    const t = await read();
    await invoke("transitionTicket", [fixture.sid, id, outcome, fixture.wid, fixture.shift, "staff", t.callAttemptId]);
    await expect(customer.locator("#cancelledScreen")).toBeVisible();
    await expect(customer.locator("#exitTicket")).toContainText(label);
    await expect(customer.locator("#cancelledScreen .complete-title")).toHaveText(outcome === "no_show" ? "Ticket marked no-show" : "Service opted out");
    await customer.locator("#cancelledHomeButton").click();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS no-show and opted-out ticket presentation; no external traffic or uncaught page errors");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
