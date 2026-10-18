import assert from "node:assert/strict";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project = testProject("assisted");
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
  const manager = await context.newPage(), staff = await context.newPage();
  for (const page of [manager, staff]) page.on("pageerror", e => errors.push(e.message));
  // Force a real session-version conflict after the first transaction read.
  await context.route(origin + "/join-entry.js", async route => {
    const response = await route.fetch();
    const source = (await response.text()).replace("const nextTicketNumber = sessionData.nextTicketNumber;", "const nextTicketNumber = sessionData.nextTicketNumber; await globalThis.assistedRetryHook?.(entryId);");
    await route.fulfill({ response, body: source });
  });
  await manager.goto(origin + "/business.html");
  await expect(manager.locator("#sessionStatus")).toHaveText("Queue session ready");
  await expect(manager.locator(".assisted-issue")).toBeEnabled();
  await manager.evaluate(async () => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js"), join = await import("/join-entry.js");
    const sid = await app.initializeTurnCue();
    const scope = { businessId: app.BUSINESS_ID, locationId: app.LOCATION_ID, queueId: app.QUEUE_ID, sessionId: sid };
    const read = async id => (await sdk.getDocFromServer(sdk.doc(app.db, "sessions", sid, "entries", id))).data();
    const session = async () => (await sdk.getDocFromServer(sdk.doc(app.db, "sessions", sid))).data();
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    await join.joinEntry(app.db, { ...scope, entryId: "normal-first" });
    const request = join.createAssistedRequest(scope);
    const start = (await session()).nextTicketNumber;
    let retries = 0;
    globalThis.assistedRetryHook = async id => {
      if (id !== request.entryId) return;
      retries++;
      if (retries === 1) {
        const current = await session();
        await sdk.updateDoc(sdk.doc(app.db, "sessions", sid), { queueRevision: (current.queueRevision || 0) + 1 });
      }
    };
    const issued = await join.issueAssistedEntry(app.db, request);
    globalThis.assistedRetryHook = null;
    check(retries >= 2, "Expected actual transaction retry");
    const ticket = await read(request.entryId);
    check(ticket.status === "waiting" && ticket.ticketNumber === start, "Wrong assisted counter/state");
    check(ticket.recoveryCode === request.recoveryCode && issued.recoveryCode === request.recoveryCode, "Retry changed code");
    check(!("queueOrder" in ticket) && !ticket.calledWindowId && !ticket.calledByShiftId, "Assisted priority/assignment");
    check(!("recoveryCode" in await read("normal-first")), "Legacy normal JOIN changed");
    await join.issueAssistedEntry(app.db, request);
    check((await session()).nextTicketNumber === start + 1, "Duplicate issuance incremented counter");
    try { await join.issueAssistedEntry(app.db, { ...request, recoveryCode: "ABCDEFGH" === request.recoveryCode ? "BCDEFGHJ" : "ABCDEFGH" }); throw new Error("Conflict accepted"); }
    catch (e) { check(e.message !== "Conflict accepted", e.message); }
    for (const patch of [{ recoveryCode: "ABCDEFGH" === request.recoveryCode ? "BCDEFGHJ" : "ABCDEFGH" }, { recoveryCode: sdk.deleteField() }]) {
      try { await sdk.updateDoc(sdk.doc(app.db, "sessions", sid, "entries", request.entryId), patch); throw new Error("Credential mutation accepted"); }
      catch (e) { check(e.code === "permission-denied", "Expected credential mutation denial: " + e.message); }
    }
    const concurrent = join.createAssistedRequest(scope), before = (await session()).nextTicketNumber;
    await Promise.all([join.joinEntry(app.db, { ...scope, entryId: "normal-concurrent" }), join.issueAssistedEntry(app.db, concurrent)]);
    const numbers = [(await read("normal-concurrent")).ticketNumber, (await read(concurrent.entryId)).ticketNumber].sort((a,b) => a-b);
    check(numbers[0] === before && numbers[1] === before + 1 && (await session()).nextTicketNumber === before + 2, "Concurrent numbering failed");
    const wid = await app.saveWindow(null, "Assisted Test", true), code = await app.registerStaff("Issuing Staff", "staff");
    const shift = await app.startShift((await app.findStaff(code)).id, wid);
    const racing = join.createAssistedRequest(scope);
    const [calledLabel] = await Promise.all([app.callNext(wid, shift, sid), join.issueAssistedEntry(app.db, racing)]);
    check(calledLabel === (await read("normal-first")).ticketLabel, "Assisted JOIN bypassed FIFO");
    const called = await read("normal-first");
    await app.resolveAndContinue(sid, "normal-first", wid, shift, called.callAttemptId, "completed", "next");
    check((await read(request.entryId)).status === "called", "Next assisted ticket not FIFO");
    const calledAssisted = await read(request.entryId);
    await app.transitionTicket(sid, request.entryId, "confirm_present", wid, shift, "staff", calledAssisted.callAttemptId);
    check((await read(request.entryId)).calledAt.toMillis() === calledAssisted.calledAt.toMillis(), "Presence reset service clock");
    check((await read(request.entryId)).recoveryCode === request.recoveryCode, "Lifecycle altered code");
    await app.resolveAndContinue(sid, request.entryId, wid, shift, calledAssisted.callAttemptId, "completed", "pause");
    window.assistedFixture = { sid, code };
  });
  console.log("PASS shared counter/FIFO, mixed JOIN and CALL contention, stable transaction retry, repeated issuance, immutable code and lifecycle compatibility");
  const count = () => manager.evaluate(async () => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const entries = await sdk.getDocsFromServer(sdk.collection(app.db, "sessions", window.assistedFixture.sid, "entries"));
    return entries.size;
  });
  let before = await count();
  await manager.locator(".assisted-issue").click();
  await expect(manager.locator(".assisted-result")).toHaveText(/Ticket: A\d+ · Recovery code: [A-HJ-NP-Z2-9]{8}/);
  assert.equal(await count(), before + 1);
  const code = await manager.evaluate(() => window.assistedFixture.code);
  await staff.goto(origin + "/staff.html");
  await expect(staff.locator("#assistedIssuance")).toBeHidden();
  await staff.locator("#staffCode").fill(code); await staff.locator("#entryForm button").click(); await staff.locator("#confirmButton").click();
  await expect(staff.locator(".assisted-issue")).toBeEnabled(); before = await count();
  await staff.locator(".assisted-issue").click();
  await expect(staff.locator(".assisted-result")).toHaveText(/Ticket: A\d+ · Recovery code: [A-HJ-NP-Z2-9]{8}/);
  assert.equal(await count(), before + 1);
  // Simulate a lost response after commit; retry must reuse the UI's request.
  await staff.route(origin + "/join-entry.js", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace("const ticketLabel = await joinEntry(db, request);", "const ticketLabel = await joinEntry(db, request); if (!globalThis.lostIssuanceResponse) { globalThis.lostIssuanceResponse = true; throw new Error('Simulated response loss'); }");
    await route.fulfill({ response, body });
  });
  await staff.reload(); await staff.locator("#staffCode").fill(code); await staff.locator("#entryForm button").click(); await staff.locator("#confirmButton").click();
  await expect(staff.locator(".assisted-issue")).toBeEnabled(); before = await count();
  await staff.locator(".assisted-issue").click(); await expect(staff.locator(".assisted-result")).toContainText("Simulated response loss");
  await expect(staff.locator(".assisted-result")).not.toContainText("Recovery code:");
  assert.equal(await count(), before + 1);
  await staff.getByRole("button", { name: "RETRY ISSUANCE", exact: true }).click();
  await expect(staff.locator(".assisted-result")).toHaveText(/Ticket: A\d+ · Recovery code: [A-HJ-NP-Z2-9]{8}/);
  assert.equal(await count(), before + 1);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS staff/manager issuance handoff and lost-response retry without duplicate ticket");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
