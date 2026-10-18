import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project = testProject("code-recovery");
await compileRules(project);
const server = await startBrowserServer(project), origin = "http://127.0.0.1:" + server.address().port;
const emulator = "http://127.0.0.1:8787", errors = [], external = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let lookupGate = null;
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    const gate = lookupGate;
    if (gate && !gate.held && url.origin === emulator
      && url.pathname.endsWith("/google.firestore.v1.Firestore/Listen/channel")
      && route.request().frame().page() === gate.page && route.request().method() === "POST") {
      const body = decodeURIComponent(route.request().postData() || "");
      if (body.includes("ticketLabel") && body.includes(gate.ticketLabel)) {
        gate.held = true; gate.reached(); await gate.resume;
      }
    }
    if ([origin, emulator].includes(url.origin)) return route.continue();
    if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) return route.fulfill({ path: path.join(process.env.TURNCUE_TEST_ASSETS, path.basename(url.pathname)), contentType: "text/javascript" });
    if (!(url.origin === "https://www.google.com" && url.pathname === "/images/cleardot.gif")) external.push(url.href);
    return route.abort();
  });
  const manager = await context.newPage(), customer = await context.newPage();
  for (const page of [manager, customer]) page.on("pageerror", e => errors.push(e.message));
  await manager.goto(origin + "/staff.html");
  const fixture = await manager.evaluate(async () => {
    const app = await import("/turncue.js"), join = await import("/join-entry.js");
    const sid = await app.initializeTurnCue(), wid = await app.saveWindow(null, "Recovery Code", true), code = await app.registerStaff("Recovery Staff", "staff");
    const shift = await app.startShift((await app.findStaff(code)).id, wid);
    const scope = { businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid };
    await join.joinEntry(app.db, { ...scope, entryId: "legacy" });
    const ticket = await join.issueAssistedEntry(app.db, join.createAssistedRequest(scope));
    return { sid, wid, shift, ticket };
  });
  const invoke = (name, args) => manager.evaluate(async ({ name, args }) => (await import("/turncue.js"))[name](...args), { name, args });
  const state = () => manager.evaluate(async sid => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const session = (await sdk.getDocFromServer(sdk.doc(app.db, "sessions", sid))).data();
    const entries = await sdk.getDocsFromServer(sdk.collection(app.db, "sessions", sid, "entries"));
    return JSON.parse(JSON.stringify({ counter: session.nextTicketNumber, entries: entries.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => a.id.localeCompare(b.id)) }));
  }, fixture.sid);
  const saved = () => customer.evaluate(async () => {
    const { environment } = await import("/firebase-client.js");
    return JSON.parse(localStorage.getItem(environment.storagePrefix + ":active_entry"));
  });
  async function fresh() {
    await customer.goto(origin + "/index.html");
    await customer.evaluate(async () => {
      const { environment } = await import("/firebase-client.js");
      localStorage.removeItem(environment.storagePrefix + ":active_entry");
    });
    await customer.reload(); await expect(customer.locator("#recoverTicketButton")).toBeVisible();
  }
  async function submit(ticket = fixture.ticket) {
    await customer.locator("#recoveryTicketNumber").fill(" " + ticket.ticketLabel.toLowerCase() + " ");
    await customer.locator("#recoveryCode").fill(ticket.recoveryCode.toLowerCase());
    await customer.locator("#recoverTicketButton").click();
  }
  const generic = "We couldn't find a matching ticket. Please check your ticket number and recovery code and try again.";
  await fresh(); const original = await state();
  for (const ticket of [
    { ticketLabel: fixture.ticket.ticketLabel, recoveryCode: "ABCDEFGH" === fixture.ticket.recoveryCode ? "BCDEFGHJ" : "ABCDEFGH" },
    { ticketLabel: "A99999", recoveryCode: "ABCDEFGH" },
    { ticketLabel: "", recoveryCode: "" },
    { ticketLabel: "?", recoveryCode: "INVALID!" },
    { ticketLabel: "A101", recoveryCode: "ABCDEFGH" }
  ]) {
    await submit(ticket); await expect(customer.locator("#ticketRecoveryError")).toHaveText(generic);
    assert.equal(await saved(), null); assert.deepEqual(await state(), original);
  }
  await submit(); await expect(customer.locator("#waitingMessage")).toBeVisible();
  await expect(customer.locator("#position")).toHaveText("#2");
  assert.equal((await saved()).entryId, fixture.ticket.entryId); assert.deepEqual(await state(), original);
  await customer.reload(); await expect(customer.locator("#waitingMessage")).toBeVisible(); assert.deepEqual(await state(), original);
  await fresh(); await submit(); await expect(customer.locator("#waitingMessage")).toBeVisible(); assert.deepEqual(await state(), original);
  console.log("PASS normalized WAITING attachment, position, repeat/refresh, generic invalid/legacy rejection and no writes/duplicates");

  // Hold the real lookup request while CALL moves the existing ticket to CALLED.
  await fresh();
  let lookupReached, releaseLookup;
  const reached = new Promise(resolve => { lookupReached = resolve; });
  const resume = new Promise(resolve => { releaseLookup = resolve; });
  lookupGate = { page: customer, ticketLabel: fixture.ticket.ticketLabel, held: false, reached: lookupReached, resume };
  await submit(); await reached;
  await expect(customer.locator("#joinButton")).toBeDisabled();
  await invoke("callNext", [fixture.wid, fixture.shift, fixture.sid]);
  let snapshot = await state(), legacy = snapshot.entries.find(t => t.id === "legacy");
  await invoke("resolveAndContinue", [fixture.sid, "legacy", fixture.wid, fixture.shift, legacy.callAttemptId, "completed", "next"]);
  snapshot = await state(); const called = snapshot.entries.find(t => t.id === fixture.ticket.entryId);
  releaseLookup(); lookupGate = null;
  await expect(customer.locator("#imHereButton")).toBeVisible(); assert.deepEqual(await state(), snapshot);
  await fresh(); await submit(); await expect(customer.locator("#imHereButton")).toBeVisible(); assert.deepEqual(await state(), snapshot);
  await assert.rejects(invoke("transitionTicket", [fixture.sid, fixture.ticket.entryId, "confirm_present", fixture.wid, fixture.shift, "customer", "stale"]));
  await customer.locator("#imHereButton").click(); await expect(customer.locator("#calledTitle")).toHaveText("Service in progress");
  snapshot = await state(); const progress = snapshot.entries.find(t => t.id === fixture.ticket.entryId);
  assert.deepEqual(progress.calledAt, called.calledAt); assert.equal(progress.callAttemptId, called.callAttemptId);
  await fresh(); await submit(); await expect(customer.locator("#calledTitle")).toHaveText("Service in progress");
  await expect(customer.locator("#imHereButton")).toBeHidden(); assert.deepEqual(await state(), snapshot);
  await invoke("resolveAndContinue", [fixture.sid, fixture.ticket.entryId, fixture.wid, fixture.shift, called.callAttemptId, "completed", "pause"]);
  await expect(customer.locator("#completedScreen")).toBeVisible(); snapshot = await state();
  await fresh(); await submit(); await expect(customer.locator("#completedScreen")).toBeVisible();
  await expect(customer.locator("#completedTicket")).toContainText(fixture.ticket.ticketLabel); assert.deepEqual(await state(), snapshot);
  console.log("PASS CALL race, CALLED/IN_PROGRESS attempts/timing and COMPLETED code recovery");

  await invoke("changeWindowState", [fixture.wid, fixture.shift, "resume"]);
  for (const outcome of ["no_show", "opted_out", "left_queue"]) {
    const ticket = await manager.evaluate(async sid => {
      const app = await import("/turncue.js"), join = await import("/join-entry.js");
      return join.issueAssistedEntry(app.db, join.createAssistedRequest({ businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid }));
    }, fixture.sid);
    if (outcome === "left_queue") await invoke("transitionTicket", [fixture.sid, ticket.entryId, outcome]);
    else {
      await invoke("callNext", [fixture.wid, fixture.shift, fixture.sid]);
      const current = (await state()).entries.find(t => t.id === ticket.entryId);
      await invoke("transitionTicket", [fixture.sid, ticket.entryId, outcome, fixture.wid, fixture.shift, "staff", current.callAttemptId]);
    }
    const terminal = await state(); await fresh(); await submit(ticket);
    await expect(customer.locator("#cancelledScreen")).toBeVisible(); await expect(customer.locator("#exitTicket")).toContainText(ticket.ticketLabel);
    assert.deepEqual(await state(), terminal);
    await customer.reload(); await expect(customer.locator("#cancelledScreen")).toBeVisible(); assert.deepEqual(await state(), terminal);
  }
  console.log("PASS NO_SHOW/OPTED_OUT/LEFT_QUEUE outcomes and subsequent existing 4D reload");

  await fresh();
  const rules = fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), start = rules.indexOf("match /entries/{entryId}");
  const deny = rules.slice(0, start) + rules.slice(start).replace("allow read: if true;", "allow read: if false;");
  const response = await fetch(`${emulator}/emulator/v1/projects/${project}:securityRules`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content: deny }] } }) });
  assert(response.ok); await submit();
  await expect(customer.locator("#retryRecoveryButton")).toBeVisible(); await expect(customer.locator("#joinButton")).toBeDisabled();
  await compileRules(project); await customer.locator("#retryRecoveryButton").click(); await expect(customer.locator("#completedScreen")).toBeVisible();
  assert.equal((await saved()).entryId, fixture.ticket.entryId);
  // A ticket in another session is intentionally outside the bounded lookup.
  const other = await manager.evaluate(async () => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const scope = { businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID };
    await sdk.setDoc(sdk.doc(app.db, "sessions", "previous"), { ...scope, status: "open", ticketPrefix: "B", nextTicketNumber: 102, openedAt: sdk.serverTimestamp(), closedAt: null });
    await sdk.setDoc(sdk.doc(app.db, "sessions", "previous", "entries", "old"), { ...scope, sessionId: "previous", ticketNumber: 101, ticketLabel: "B101", recoveryCode: "ABCDEFGH", status: "waiting", joinedAt: sdk.serverTimestamp(), calledAt: null, completedAt: null, cancelledAt: null });
    return { ticketLabel: "B101", recoveryCode: "ABCDEFGH" };
  });
  await fresh(); const before = await state(); await submit(other);
  await expect(customer.locator("#ticketRecoveryError")).toHaveText(generic); assert.deepEqual(await state(), before);
  // Legacy ticket remains usable through the same-browser identifier path.
  await customer.evaluate(async sid => {
    const { environment } = await import("/firebase-client.js");
    localStorage.setItem(environment.storagePrefix + ":active_entry", JSON.stringify({ sessionId: sid, entryId: "legacy" }));
  }, fixture.sid);
  await customer.reload(); await expect(customer.locator("#completedScreen")).toBeVisible();
  await expect(customer.locator("#completedTicket")).toContainText("A101");
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS temporary lookup failure/retry, current-session isolation and legacy same-browser compatibility");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
