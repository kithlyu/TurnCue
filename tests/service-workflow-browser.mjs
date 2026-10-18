import assert from "node:assert/strict";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";

const project = testProject("service-ui"), assets = process.env.TURNCUE_TEST_ASSETS;
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
  const staff = await context.newPage(), customer = await context.newPage();
  for (const page of [staff, customer]) page.on("pageerror", error => errors.push(error.message));
  await staff.goto(origin + "/staff.html");
  const fixture = await staff.evaluate(async () => {
    const app = await import("/turncue.js");
    const sid = await app.initializeTurnCue(), wid = await app.saveWindow(null, "Browser Service", true), code = await app.registerStaff("Browser Staff", "staff");
    return { sid, wid, code };
  });
  await staff.locator("#staffCode").fill(fixture.code);
  await staff.getByRole("button", { name: "CONTINUE", exact: true }).click();
  await staff.locator("#confirmButton").click();
  await staff.getByRole("button", { name: "START SHIFT", exact: true }).click();
  await staff.locator("#windowChoice").selectOption(fixture.wid);
  await staff.getByRole("button", { name: "START AT SELECTED WINDOW" }).click();
  await expect(staff.getByRole("button", { name: "CALL NEXT", exact: true })).toBeEnabled();
  const currentWindow = () => staff.evaluate(async wid => {
    const { db } = await import("/firebase-client.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const w = (await sdk.getDocFromServer(sdk.doc(db, "windows", wid))).data();
    return { ...w, calledAtMs: w.currentEntryCalledAt?.toMillis() };
  }, fixture.wid);
  async function join() {
    await customer.goto(origin + "/index.html");
    await customer.locator("#joinButton").click();
    await expect(customer.locator("#queueScreen")).toBeVisible();
    return customer.evaluate(async () => {
      const { environment } = await import("/firebase-client.js");
      return JSON.parse(localStorage.getItem(environment.storagePrefix + ":active_entry")).entryId;
    });
  }
  const readTicket = id => staff.evaluate(async ({ sid, id }) => {
    const { db } = await import("/firebase-client.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const t = (await sdk.getDocFromServer(sdk.doc(db, "sessions", sid, "entries", id))).data();
    return { ...t, calledAtMs: t.calledAt?.toMillis() };
  }, { sid: fixture.sid, id });
  async function waitForCall(id) {
    let callAttemptId;
    await expect.poll(async () => {
      const ticket = await readTicket(id), window = await currentWindow();
      callAttemptId = ticket.callAttemptId;
      return ticket.status === "called" && Boolean(callAttemptId) && Number.isFinite(ticket.calledAtMs)
        && ticket.calledWindowId === fixture.wid && ticket.calledByShiftId === window.currentShiftId
        && window.currentSessionId === fixture.sid && window.currentEntryId === id
        && window.currentCallAttemptId === callAttemptId && Number.isFinite(window.calledAtMs);
    }).toBe(true);
    return callAttemptId;
  }
  async function backdate(id, seconds, callAttemptId) {
    assert.equal(await waitForCall(id), callAttemptId);
    const time = new Date(Date.now() - seconds * 1000).toISOString();
    for (const [p, f] of [[`sessions/${fixture.sid}/entries/${id}`, "calledAt"], [`windows/${fixture.wid}`, "currentEntryCalledAt"]]) {
      const response = await fetch(`${emulator}/v1/projects/${project}/databases/(default)/documents/${p}?updateMask.fieldPaths=${f}`, {
        method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields: { [f]: { timestampValue: time } } })
      });
      assert(response.ok, await response.text());
    }
    await expect.poll(async () => {
      const ticket = await readTicket(id), window = await currentWindow();
      return ticket.status === "called" && ticket.callAttemptId === callAttemptId
        && ticket.calledWindowId === fixture.wid && window.currentEntryId === id
        && window.currentSessionId === fixture.sid && window.currentCallAttemptId === callAttemptId
        && ticket.calledAtMs === Date.parse(time) && window.calledAtMs === Date.parse(time);
    }).toBe(true);
  }
  const first = await join();
  await staff.getByRole("button", { name: "CALL NEXT", exact: true }).click();
  const firstAttempt = await waitForCall(first);
  await expect(customer.locator("#imHereButton")).toBeVisible();
  await expect(customer.locator("#calledDestination")).toContainText("Browser Service");
  await expect(staff.locator("#arrivalDecisionActions")).toBeHidden();
  await expect(staff.getByRole("button", { name: "COMPLETE & PAUSE", exact: true })).toHaveCount(0);
  await backdate(first, 30, firstAttempt);
  await expect(staff.locator("#serviceClock")).toContainText("0:3");
  const calledAt = (await readTicket(first)).calledAtMs;
  await customer.locator("#imHereButton").click();
  await expect(customer.locator("#calledTitle")).toHaveText("Service in progress");
  await expect(customer.locator("#imHereButton")).toBeHidden();
  await expect(staff.getByRole("button", { name: "THEY'RE HERE" })).toHaveCount(0);
  await expect(staff.locator("#serviceClock")).toContainText("0:3");
  assert.equal((await readTicket(first)).calledAtMs, calledAt);
  await staff.getByRole("button", { name: "COMPLETE & PAUSE", exact: true }).click();
  await expect(customer.locator("#completedScreen")).toBeVisible();
  await expect(staff.getByRole("button", { name: "RESUME", exact: true })).toBeVisible();
  assert.equal((await currentWindow()).currentEntryId, null);
  await customer.locator("#backHomeButton").click();
  await staff.getByRole("button", { name: "RESUME", exact: true }).click();

  const second = await join();
  await staff.getByRole("button", { name: "CALL NEXT", exact: true }).click();
  await staff.getByRole("button", { name: "THEY'RE HERE" }).click();
  await expect(customer.locator("#calledTitle")).toHaveText("Service in progress");
  await staff.getByRole("button", { name: "COMPLETE & CALL NEXT" }).click();
  await expect(customer.locator("#completedScreen")).toBeVisible();
  assert.equal((await readTicket(second)).status, "completed");
  assert.equal((await currentWindow()).state, "active");
  await customer.locator("#backHomeButton").click();
  const third = await join();
  assert.equal((await readTicket(third)).status, "waiting");
  assert.equal((await currentWindow()).currentEntryId, null);
  await staff.getByRole("button", { name: "CALL NEXT", exact: true }).click();
  const thirdAttempt = await waitForCall(third);
  await expect(staff.locator("#arrivalDecisionActions")).toBeHidden();
  await backdate(third, 121, thirdAttempt);
  await expect(staff.locator("#arrivalDecisionActions")).toBeVisible();
  assert.equal((await readTicket(third)).status, "called");
  await staff.getByRole("button", { name: "NO SHOW & PAUSE" }).click();
  await expect(customer.locator("#cancelledScreen")).toBeVisible();
  assert.equal((await readTicket(third)).status, "no_show");
  await customer.locator("#cancelledHomeButton").click();
  await staff.getByRole("button", { name: "RESUME", exact: true }).click();

  await staff.evaluate(async ({ sid, wid }) => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const window = (await sdk.getDocFromServer(sdk.doc(app.db, "windows", wid))).data();
    for (let i = 0; i < 3; i++) await sdk.setDoc(sdk.doc(app.db, "queues", app.QUEUE_ID, "serviceSamples", "ui-pace-" + i), {
      businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid, entryId: "ui-pace-" + i, windowId: wid, shiftId: window.currentShiftId,
      calledAt: sdk.Timestamp.fromMillis(Date.now() - 600000), completedAt: sdk.serverTimestamp(), durationSeconds: null, durationMinutes: null, cleanEligible: true, exclusionReason: null, recordedAt: sdk.serverTimestamp()
    });
  }, fixture);
  const fourth = await join();
  await staff.getByRole("button", { name: "CALL NEXT", exact: true }).click();
  await staff.getByRole("button", { name: "THEY'RE HERE" }).click();
  await staff.getByRole("button", { name: "STAFF NEED MORE TIME" }).click();
  await expect(customer.locator("#waitingMessage")).toBeVisible();
  assert.equal((await readTicket(fourth)).callAttemptId, null);
  await staff.getByRole("button", { name: "CALL NEXT", exact: true }).click();
  await staff.getByRole("button", { name: "THEY'RE HERE" }).click();
  await expect(staff.getByRole("button", { name: "STAFF NEED MORE TIME" })).toBeDisabled();
  await staff.getByRole("button", { name: "OPTED OUT" }).click();
  await expect(customer.locator("#cancelledScreen")).toBeVisible();
  assert.equal((await readTicket(fourth)).status, "opted_out");
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS staff selection, customer/staff presence, unchanged timer, arrival decision, paired controls, deferred service and opted-out cleanup");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
