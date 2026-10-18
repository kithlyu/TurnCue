import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project = testProject("staff-connect");
await compileRules(project);
const server = await startBrowserServer(project), origin = "http://127.0.0.1:" + server.address().port;
const emulator = "http://127.0.0.1:8787", errors = [], external = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  async function newPage() {
    const context = await browser.newContext();
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if ([origin, emulator].includes(url.origin)) return route.continue();
      if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) {
        let body = fs.readFileSync(path.join(process.env.TURNCUE_TEST_ASSETS, path.basename(url.pathname)), "utf8");
        if (url.pathname.endsWith("firebase-firestore.js")) {
          const start = body.lastIndexOf("export{");
          assert(start >= 0 && /([,{])onSnapshot(?=[,}])/.test(body.slice(start)));
          body = body.slice(0, start) + body.slice(start).replace(/([,{])onSnapshot(?=[,}])/, "$1onSnapshot as originalOnSnapshot") + `\nconst originalOnSnapshot = onSnapshot; function countedSnapshot(...args) { globalThis.subscriptionStarts = (globalThis.subscriptionStarts || 0) + 1; const stop = originalOnSnapshot(...args); return () => { globalThis.subscriptionStops = (globalThis.subscriptionStops || 0) + 1; stop(); }; } export { countedSnapshot as onSnapshot };`;
        }
        return route.fulfill({ body, contentType: "text/javascript" });
      }
      if (!(url.origin === "https://www.google.com" && url.pathname === "/images/cleardot.gif")) external.push(url.href);
      return route.abort();
    });
    const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message)); return page;
  }
  const manager = await newPage(), staff = await newPage(), peer = await newPage();
  await manager.goto(origin + "/business.html");
  await expect(manager.locator("#sessionStatus")).toHaveText("Queue session ready");
  const fixture = await manager.evaluate(async () => {
    const app = await import("/turncue.js"), join = await import("/join-entry.js");
    const sid = await app.initializeTurnCue(), wid = await app.saveWindow(null, "Freshness Test", true), code = await app.registerStaff("Freshness Staff", "staff");
    const shift = await app.startShift((await app.findStaff(code)).id, wid);
    const scope = { businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid };
    const label = await join.joinEntry(app.db, { ...scope, entryId: "first" });
    await join.joinEntry(app.db, { ...scope, entryId: "second" });
    return { sid, wid, shift, code, label };
  });
  for (const page of [staff, peer]) {
    await page.goto(origin + "/staff.html"); await page.locator("#staffCode").fill(fixture.code);
    await page.locator("#entryForm button").click(); await page.locator("#confirmButton").click();
    await expect(page.locator("#freshnessNotice")).toHaveAttribute("data-state", "server-confirmed");
    await expect(page.getByRole("button", { name: "CALL NEXT", exact: true })).toBeEnabled();
  }
  await expect(manager.locator("#freshnessNotice")).toHaveAttribute("data-state", "server-confirmed");
  const state = () => manager.evaluate(async sid => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const read = async segments => (await sdk.getDocsFromServer(sdk.collection(app.db, ...segments))).docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => a.id.localeCompare(b.id));
    return JSON.parse(JSON.stringify({ entries: await read(["sessions", sid, "entries"]), windows: await read(["windows"]), shifts: await read(["shifts"]), staff: await read(["staff"]) }));
  }, fixture.sid);
  const operationalState = snapshot => {
    const normalized = structuredClone(snapshot);
    for (const window of normalized.windows) {
      delete window.lastPresenceAt;
      delete window.lastPresenceBrowserId;
    }
    return normalized;
  };
  const network = (page, enabled) => page.evaluate(async enabled => {
    const { db } = await import("/firebase-client.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    await sdk[enabled ? "enableNetwork" : "disableNetwork"](db);
  }, enabled);
  const count = page => page.evaluate(() => ({ starts: subscriptionStarts, stops: globalThis.subscriptionStops || 0 }));
  const call = page => page.getByRole("button", { name: "CALL NEXT", exact: true });
  const pause = page => page.getByRole("button", { name: "PAUSE", exact: true });
  const before = await state(), subscriptions = await count(staff);
  await network(staff, false); await expect(staff.locator("#freshnessNotice")).toHaveAttribute("data-state", "uncertain");
  await expect(call(staff)).toBeDisabled(); await expect(pause(staff)).toBeDisabled();
  await expect(staff.locator("#assignment")).toContainText("Freshness Test");
  await expect(staff.locator(".lookup-number")).toBeEnabled(); await expect(staff.locator('nav a[href="business.html"]')).toBeVisible();
  assert.deepEqual(operationalState(await state()), operationalState(before));
  await network(staff, true); await expect(staff.locator("#freshnessNotice")).toHaveAttribute("data-state", "server-confirmed");
  await expect(call(staff)).toBeEnabled(); assert.deepEqual(await count(staff), subscriptions);
  console.log("PASS staff idle/WAITING freshness, CALL/pause gating, preserved assignment, lookup/navigation, unchanged ownership and unchanged-data reconnect without duplicate listeners");
  await call(peer).click(); await expect(staff.locator("#assignment")).toContainText("Called: " + fixture.label);
  await expect(staff.locator("#freshnessNotice")).toHaveAttribute("data-state", "server-confirmed");
  const called = await state(), assignedSubscriptions = await count(staff);
  await staff.context().setOffline(true); await expect(staff.locator("#freshnessNotice")).toHaveAttribute("data-state", "stale");
  await expect(staff.locator("#assignment")).toContainText("Called: " + fixture.label);
  await expect(staff.locator("#serviceClock")).toContainText("Service time:");
  await expect(staff.getByRole("button", { name: "THEY'RE HERE", exact: true })).toBeEnabled();
  await expect(pause(staff)).toBeDisabled(); assert.deepEqual(operationalState(await state()), operationalState(called));
  await staff.context().setOffline(false); await expect(staff.locator("#freshnessNotice")).toHaveAttribute("data-state", "server-confirmed");
  assert.deepEqual(await count(staff), assignedSubscriptions);
  await peer.getByRole("button", { name: "THEY'RE HERE", exact: true }).click();
  await expect(staff.locator("#assignment")).toContainText("Service in progress: " + fixture.label);
  const progress = await state();
  assert.deepEqual(progress.entries.find(e => e.id === "first").calledAt, called.entries.find(e => e.id === "first").calledAt);
  assert.equal(progress.entries.find(e => e.id === "first").callAttemptId, called.entries.find(e => e.id === "first").callAttemptId);
  await network(staff, false); await expect(staff.locator("#freshnessNotice")).toHaveAttribute("data-state", "uncertain");
  await expect(staff.locator("#assignment")).toContainText("Service in progress: " + fixture.label);
  await expect(staff.getByRole("button", { name: "COMPLETE & PAUSE", exact: true })).toBeEnabled();
  assert.deepEqual(operationalState(await state()), operationalState(progress));
  await network(staff, true); await expect(staff.locator("#freshnessNotice")).toHaveAttribute("data-state", "server-confirmed");
  assert.deepEqual(await count(staff), assignedSubscriptions);
  console.log("PASS CALLED/IN_PROGRESS preservation, unchanged calledAt/attempt, assigned controls retained, browser offline warning and same-Staff-ID peer updates");
  const managerSubscriptions = await count(manager);
  await network(manager, false); await expect(manager.locator("#freshnessNotice")).toHaveAttribute("data-state", "uncertain");
  await expect(pause(manager)).toBeDisabled(); await expect(manager.locator("#called")).toContainText(fixture.label);
  await expect(manager.locator(".lookup-number")).toBeEnabled();
  await network(manager, true); await expect(manager.locator("#freshnessNotice")).toHaveAttribute("data-state", "server-confirmed");
  assert.deepEqual(await count(manager), managerSubscriptions); assert.deepEqual(operationalState(await state()), operationalState(progress));
  await peer.getByRole("button", { name: "COMPLETE & PAUSE", exact: true }).click();
  await expect(staff.getByRole("button", { name: "RESUME", exact: true })).toBeEnabled();
  const paused = await state();
  await network(staff, false); await expect(staff.getByRole("button", { name: "RESUME", exact: true })).toBeDisabled();
  assert.deepEqual(operationalState(await state()), operationalState(paused));
  await network(staff, true); await expect(staff.getByRole("button", { name: "RESUME", exact: true })).toBeEnabled();
  await network(manager, false); await expect(manager.getByRole("button", { name: "RESUME", exact: true })).toBeDisabled();
  await network(manager, true); await expect(manager.getByRole("button", { name: "RESUME", exact: true })).toBeEnabled();
  await peer.getByRole("button", { name: "RESUME", exact: true }).click(); await expect(call(manager)).toBeEnabled();
  const idle = await state(); await network(manager, false); await expect(call(manager)).toBeDisabled();
  await network(manager, true); await expect(call(manager)).toBeEnabled(); assert.deepEqual(operationalState(await state()), operationalState(idle));
  assert.deepEqual(await count(manager), managerSubscriptions); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS manager freshness/display/lookup, CALL and pause/resume gates, unchanged ownership/lifecycle on loss, peer compatibility and no unexpected traffic/errors");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
