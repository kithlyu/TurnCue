import assert from "node:assert/strict";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project = testProject("lookup");
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
  // Count only lookup subscriptions, leaving real Firestore callbacks intact.
  await context.route(origin + "/ticket-lookup-ui.js", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('import { watchEntry }', 'import { watchEntry as originalWatchEntry }').replace('export function ticketLookupControls', 'const watchEntry = (...args) => { globalThis.lookupStarts = (globalThis.lookupStarts || 0) + 1; const stop = originalWatchEntry(...args); return () => { globalThis.lookupStops = (globalThis.lookupStops || 0) + 1; stop(); }; };\nexport function ticketLookupControls');
    await route.fulfill({ response, body });
  });
  const manager = await context.newPage(), staff = await context.newPage();
  for (const page of [manager, staff]) page.on("pageerror", error => errors.push(error.message));
  await manager.goto(origin + "/business.html");
  await expect(manager.locator("#sessionStatus")).toHaveText("Queue session ready");
  const fixture = await manager.evaluate(async () => {
    const app = await import("/turncue.js"), join = await import("/join-entry.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const sid = await app.initializeTurnCue(), wid = await app.saveWindow(null, "Lookup Test", true), code = await app.registerStaff("Lookup Staff", "staff");
    const staffId = (await app.findStaff(code)).id;
    const shift = await app.startShift(staffId, wid);
    const scope = { businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid };
    await join.joinEntry(app.db, { ...scope, entryId: "legacy" });
    const ticket = await join.issueAssistedEntry(app.db, join.createAssistedRequest(scope));
    for (let i = 0; i < 3; i++) {
      await join.joinEntry(app.db, { ...scope, entryId: "behind-" + i });
      await sdk.setDoc(sdk.doc(app.db, "queues", app.QUEUE_ID, "serviceSamples", "pace-" + i), { ...scope, entryId: "pace-" + i, windowId: wid, shiftId: shift, calledAt: sdk.Timestamp.fromMillis(Date.now() - 600000), completedAt: sdk.serverTimestamp(), durationSeconds: null, durationMinutes: null, cleanEligible: true, exclusionReason: null, recordedAt: sdk.serverTimestamp() });
    }
    return { sid, wid, shift, code, ticket, staffId };
  });
  const invoke = (name, args) => manager.evaluate(async ({ name, args }) => (await import("/turncue.js"))[name](...args), { name, args });
  const state = () => manager.evaluate(async sid => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const read = async segments => { const docs = await sdk.getDocsFromServer(sdk.collection(app.db, ...segments)); return docs.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => a.id.localeCompare(b.id)); };
    return JSON.parse(JSON.stringify({ session: (await sdk.getDocFromServer(sdk.doc(app.db, "sessions", sid))).data(), entries: await read(["sessions", sid, "entries"]), windows: await read(["windows"]), shifts: await read(["shifts"]) }));
  }, fixture.sid);
  const operationalState = snapshot => {
    const normalized = structuredClone(snapshot);
    for (const window of normalized.windows) {
      delete window.lastPresenceAt;
      delete window.lastPresenceBrowserId;
    }
    return normalized;
  };
  const result = page => page.locator(".lookup-result");
  async function search(page, label) {
    await expect(page.locator('#ticketLookup [type="submit"]')).toBeEnabled();
    await page.locator(".lookup-number").fill(label);
    await page.locator('#ticketLookup [type="submit"]').click();
    await expect(result(page)).not.toHaveText("Searching...");
  }
  const storage = page => page.evaluate(() => JSON.stringify({ ...localStorage }));
  await staff.goto(origin + "/staff.html");
  await staff.locator("#staffCode").fill(fixture.code); await staff.locator("#entryForm button").click(); await staff.locator("#confirmButton").click();
  await expect.poll(async () => {
    const window = (await state()).windows.find(w=>w.id===fixture.wid);
    return window.presenceStaffId === fixture.staffId && window.presenceShiftId === fixture.shift && window.capacityExcludedAt === null;
  }, { timeout: 30000 }).toBe(true);
  const original = await state(), saved = await storage(manager), staffSaved = await storage(staff);
  for (const page of [manager, staff]) {
    await search(page, " " + fixture.ticket.ticketLabel.toLowerCase() + " ");
    await expect(result(page)).toContainText("Status: WAITING");
    await expect(result(page)).toContainText("Position: #2");
    await expect(result(page)).toContainText("People ahead: 1");
    await expect(result(page)).toContainText("About");
    await expect(result(page)).not.toContainText(fixture.ticket.recoveryCode);
    await expect(result(page)).not.toContainText(fixture.ticket.entryId);
    assert.equal(await result(page).locator("button,input,a").count(), 0);
  }
  assert.deepEqual(operationalState(await state()), operationalState(original)); assert.equal(await storage(manager), saved); assert.equal(await storage(staff), staffSaved);
  const proposal = await invoke("requestNeedMoreTime", [fixture.sid, fixture.ticket.entryId]);
  await invoke("confirmNeedMoreTime", [fixture.sid, fixture.ticket.entryId, proposal.proposalId]);
  await expect(result(manager)).toContainText("Position: #3"); await expect(result(staff)).toContainText("People ahead: 2");
  console.log("PASS scoped WAITING position/ETA, view-only fields/storage/state, live fairness repositioning");
  // Leave the selected ticket first, then operate through the existing staff UI.
  for (const id of ["legacy", "behind-0"]) await invoke("transitionTicket", [fixture.sid, id, "left_queue"]);
  await staff.getByRole("button", { name: "CALL NEXT", exact: true }).click();
  await expect(result(manager)).toContainText("Status: CALLED"); await expect(result(staff)).toContainText("Window: Window Lookup Test");
  await staff.getByRole("button", { name: "THEY'RE HERE", exact: true }).click();
  await expect(result(manager)).toContainText("Status: IN_PROGRESS"); await expect(result(staff)).toContainText("Service in progress");
  await search(manager, fixture.ticket.ticketLabel); await expect(result(manager)).toContainText("Status: IN_PROGRESS");
  await staff.getByRole("button", { name: "COMPLETE & PAUSE", exact: true }).click();
  await expect(result(manager)).toContainText("Status: COMPLETED"); await expect(result(manager)).toContainText("Service time:");
  await search(manager, fixture.ticket.ticketLabel); await expect(result(manager)).toContainText("Total time:");
  await invoke("changeWindowState", [fixture.wid, fixture.shift, "resume"]);
  for (const id of ["behind-1", "behind-2"]) await invoke("transitionTicket", [fixture.sid, id, "left_queue"]);
  for (const outcome of ["no_show", "opted_out", "left_queue"]) {
    const ticket = await manager.evaluate(async sid => {
      const app = await import("/turncue.js"), join = await import("/join-entry.js");
      return join.issueAssistedEntry(app.db, join.createAssistedRequest({ businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid }));
    }, fixture.sid);
    await search(manager, ticket.ticketLabel);
    if (outcome !== "left_queue") {
      await invoke("callNext", [fixture.wid, fixture.shift, fixture.sid]);
      await expect(result(manager)).toContainText("Status: CALLED");
      await search(manager, ticket.ticketLabel); await expect(result(manager)).toContainText("Arrival window:");
      const t = (await state()).entries.find(e => e.id === ticket.entryId);
      await invoke("transitionTicket", [fixture.sid, ticket.entryId, outcome, fixture.wid, fixture.shift, "staff", t.callAttemptId]);
    } else await invoke("transitionTicket", [fixture.sid, ticket.entryId, outcome]);
    await expect(result(manager)).toContainText("Status: " + outcome.toUpperCase());
    await search(manager, ticket.ticketLabel); await expect(result(manager)).toContainText("Status: " + outcome.toUpperCase());
  }
  console.log("PASS live CALLED/IN_PROGRESS/all terminal outcomes and separate staff operational controls");
  await search(manager, "A99999"); await expect(result(manager)).toContainText("Ticket not found");
  await manager.evaluate(async sid => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const scope = { businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID };
    await sdk.setDoc(sdk.doc(app.db, "sessions", "previous"), { ...scope, status: "open", ticketPrefix: "B", nextTicketNumber: 102, openedAt: sdk.serverTimestamp(), closedAt: null });
    const entry = { ...scope, sessionId: "previous", ticketNumber: 101, ticketLabel: "B101", status: "waiting", joinedAt: sdk.serverTimestamp(), calledAt: null, completedAt: null, cancelledAt: null };
    await sdk.setDoc(sdk.doc(app.db, "sessions", "previous", "entries", "old"), entry);
    for (const id of ["ambiguous-1", "ambiguous-2"]) await sdk.setDoc(sdk.doc(app.db, "sessions", sid, "entries", id), { ...entry, sessionId: sid, ticketLabel: "C101" });
  }, fixture.sid);
  await search(manager, "B101"); await expect(result(manager)).toContainText("Ticket not found");
  await search(manager, "C101"); await expect(result(manager)).toContainText("Multiple matching tickets");
  await search(manager, "A101"); await expect(result(manager)).toContainText("Status: LEFT_QUEUE");
  await search(manager, fixture.ticket.ticketLabel);
  await manager.locator(".lookup-close").click(); await expect(result(manager)).toBeEmpty();
  assert.equal(await manager.evaluate(() => lookupStarts), await manager.evaluate(() => lookupStops));
  await staff.locator("#changePerson").click(); await expect(staff.locator("#ticketLookup")).toBeHidden();
  assert.equal(await staff.evaluate(() => lookupStarts), await staff.evaluate(() => lookupStops));
  await search(manager, fixture.ticket.ticketLabel);
  await manager.evaluate(async () => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    await sdk.updateDoc(sdk.doc(app.db, "queues", app.QUEUE_ID), { currentSessionId: "previous" });
  });
  await expect(result(manager)).toBeEmpty();
  assert.equal(await manager.evaluate(() => lookupStarts), await manager.evaluate(() => lookupStops));
  assert.equal(await storage(manager), saved); assert.equal(await storage(staff), staffSaved);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS missing/previous-session/ambiguous rejection, legacy compatibility, replacement/close/staff/session listener cleanup and no recovery state");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
