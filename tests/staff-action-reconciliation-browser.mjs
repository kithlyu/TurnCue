import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project = testProject("action-check");
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
    if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) {
      let body = fs.readFileSync(path.join(process.env.TURNCUE_TEST_ASSETS, path.basename(url.pathname)), "utf8");
      if (url.pathname.endsWith("firebase-firestore.js")) {
        const start = body.lastIndexOf("export{"); assert(start >= 0);
        body = body.slice(0,start) + body.slice(start).replace(/([,{])onSnapshot(?=[,}])/, "$1onSnapshot as originalOnSnapshot") + `\nfunction countedSnapshot(...args) { globalThis.subscriptionStarts=(globalThis.subscriptionStarts||0)+1; return onSnapshot(...args); } export { countedSnapshot as onSnapshot };`;
      }
      return route.fulfill({ body, contentType: "text/javascript" });
    }
    if (!(url.origin === "https://www.google.com" && url.pathname === "/images/cleardot.gif")) external.push(url.href);
    return route.abort();
  });
  // Real transactions commit; wrappers only interrupt their returned acknowledgement.
  await context.route(origin + "/turncue.js", async route => {
    const response = await route.fetch(); let body = await response.text();
    const importToken = "getDocFromServer,";
    if (body.split(importToken).length !== 2) throw new Error("getDocFromServer import not found for view script.");
    body = body.replace(importToken, "getDocFromServer as realGetDocFromServer,");
    for (const method of ["callNext", "transitionTicket", "resolveAndContinue", "changeWindowState", "completeCustomer", "reconcileAction"]) {
      body = body.replace(`export async function ${method}(`, `async function original_${method}(`);
      const call = method === "reconcileAction"
        ? `await (async () => { try { return await original_${method}(...args); } catch (error) { globalThis.lastReconcileError = { name: error && error.name, code: error && error.code, message: error && error.message }; console.error("RECONCILE DIAGNOSTIC", (error && error.name) || "", (error && error.code) || "", (error && error.message) || ""); throw error; } })()`
        : `await original_${method}(...args)`;
      body += method === "reconcileAction"
        ? `\nexport async function reconcileAction(...args) {
        if (globalThis.failStateRead) throw Object.assign(new Error('Simulated unavailable read'), {code:'unavailable'});
        const fault = globalThis.actionFault?.method === 'reconcileAction' ? globalThis.actionFault : null;
        if (fault) { globalThis.actionFault = null; globalThis.faultReached = true; if (fault.mode === 'before') throw Object.assign(new Error('Simulated precommit failure'),{code:'unavailable'}); }
        globalThis.reconcileViewActive = true;
        globalThis.reconcileViewReads = 0;
        try {
          const value = ${call};
          if (fault) {
            if (fault.mode === 'held') { globalThis.faultCommitted = true; await new Promise(resolve => { globalThis.releaseFault = resolve; }); }
            throw Object.assign(new Error('Simulated lost acknowledgement'),{code:'unavailable'});
          }
          return value;
        } finally { globalThis.reconcileViewActive = false; }
      }`
        : `\nexport async function ${method}(...args) {
        const fault = globalThis.actionFault?.method === '${method}' ? globalThis.actionFault : null;
        if (fault) { globalThis.actionFault = null; globalThis.faultReached = true; if (fault.mode === 'before') throw Object.assign(new Error('Simulated precommit failure'),{code:'unavailable'}); }
        const value = ${call};
        if (fault) {
          if (fault.mode === 'held') { globalThis.faultCommitted = true; await new Promise(resolve => { globalThis.releaseFault = resolve; }); }
          throw Object.assign(new Error('Simulated lost acknowledgement'),{code:'unavailable'});
        }
        return value;
      }`;
    }
    const stabilityCheck = [
      "  const secondByPath = new Map();",
      "  const checks = await Promise.all([...observed.values()].map(async row => {",
      "    const second = (await getDocFromServer(row.target)).data() ?? null;",
      "    secondByPath.set(row.target.path, second);",
      "    return signature(row.target, second) === row.signature;",
      "  }));"
    ].join("\n");
    const stabilityDiagnostic = [
      "  globalThis.lastReconcileDiffs = [];",
      "  const secondByPath = new Map();",
      "  const checks = await Promise.all([...observed.values()].map(async row => {",
      "    const second = (await getDocFromServer(row.target)).data() ?? null;",
      "    secondByPath.set(row.target.path, second);",
      "    const same = signature(row.target, second) === row.signature;",
      "    if (!same) {",
      "      const first = row.value == null ? null : { ...row.value };",
      "      if (first) delete first.id;",
      "      const plain = value => value === undefined ? null : JSON.parse(JSON.stringify(value));",
      "      const fieldDiff = (left, right) => {",
      "        const a = left || {}, b = right || {};",
      "        const names = [...new Set([...Object.keys(a), ...Object.keys(b)])];",
      "        const differences = [];",
      "        for (const field of names) {",
      "          const hasA = Object.prototype.hasOwnProperty.call(a, field);",
      "          const hasB = Object.prototype.hasOwnProperty.call(b, field);",
      "          const av = hasA ? plain(a[field]) : null;",
      "          const bv = hasB ? plain(b[field]) : null;",
      "          if (!hasA || !hasB || JSON.stringify(av) !== JSON.stringify(bv)) differences.push({ field, firstPresent: hasA, secondPresent: hasB, first: av, second: bv });",
      "        }",
      "        return differences;",
      "      };",
      "      const normalizedFirst = JSON.parse(row.signature);",
      "      const normalizedSecond = JSON.parse(signature(row.target, second));",
      "      const record = { path: row.target.path, first: plain(first), second: plain(second), differences: fieldDiff(first, second), normalizedDifferences: fieldDiff(normalizedFirst, normalizedSecond), normalizedFirstKeys: normalizedFirst ? Object.keys(normalizedFirst) : [], normalizedSecondKeys: normalizedSecond ? Object.keys(normalizedSecond) : [] };",
      "      globalThis.lastReconcileDiffs.push(record);",
      "      console.error(\"RECONCILE DIAGNOSTIC DIFF\", JSON.stringify(record));",
      "    }",
      "    return same;",
      "  }));"
    ].join("\n");
    const assignedCheck = [
      "    if (!inScope(assigned) || ![\"called\", \"in_progress\"].includes(assigned.status) || assigned.sessionId !== window.currentSessionId",
      "      || assigned.calledWindowId !== window.id || assigned.calledByShiftId !== window.currentShiftId",
      "      || assigned.calledByStaffId !== window.currentStaffId || (assigned.callAttemptId ?? null) !== (window.currentCallAttemptId ?? null)) fail(\"Ticket snapshots disagree.\");"
    ].join("\n");
    const assignedDiagnostic = [
      "    const assignedMismatches = [];",
      "    if (!inScope(assigned)) assignedMismatches.push(\"scope\");",
      "    if (![\"called\", \"in_progress\"].includes(assigned.status)) assignedMismatches.push(\"status\");",
      "    if (assigned.sessionId !== window.currentSessionId) assignedMismatches.push(\"sessionId\");",
      "    if (assigned.calledWindowId !== window.id) assignedMismatches.push(\"calledWindowId\");",
      "    if (assigned.calledByShiftId !== window.currentShiftId) assignedMismatches.push(\"calledByShiftId\");",
      "    if (assigned.calledByStaffId !== window.currentStaffId) assignedMismatches.push(\"calledByStaffId\");",
      "    if ((assigned.callAttemptId ?? null) !== (window.currentCallAttemptId ?? null)) assignedMismatches.push(\"callAttemptId\");",
      "    if (assignedMismatches.length) {",
      "      globalThis.lastPointerPayload = { kind: \"assigned-ticket\", path: \"sessions/\" + window.currentSessionId + \"/entries/\" + window.currentEntryId, mismatches: assignedMismatches, window: { id: window.id, currentEntryId: window.currentEntryId, currentSessionId: window.currentSessionId, currentShiftId: window.currentShiftId, currentStaffId: window.currentStaffId, currentCallAttemptId: window.currentCallAttemptId ?? null, state: window.state }, assigned: { id: assigned.id, status: assigned.status, sessionId: assigned.sessionId, calledWindowId: assigned.calledWindowId ?? null, calledByShiftId: assigned.calledByShiftId ?? null, calledByStaffId: assigned.calledByStaffId ?? null, callAttemptId: assigned.callAttemptId ?? null } };",
      "      console.error(\"RECONCILE DIAGNOSTIC DIFF\", JSON.stringify(globalThis.lastPointerPayload));",
      "      fail(\"Ticket snapshots disagree.\");",
      "    }"
    ].join("\n");
    const originalCheck = [
      "  if (!deferStaffNeedMoreTime && window && original && [\"called\", \"in_progress\"].includes(original.status) && original.calledWindowId === window.id",
      "    && (original.id !== assigned?.id || (original.callAttemptId ?? null) !== (assigned?.callAttemptId ?? null))) fail(\"Ticket snapshots disagree.\");"
    ].join("\n");
    const originalDiagnostic = [
      "  if (!deferStaffNeedMoreTime && window && original && [\"called\", \"in_progress\"].includes(original.status) && original.calledWindowId === window.id",
      "    && (original.id !== assigned?.id || (original.callAttemptId ?? null) !== (assigned?.callAttemptId ?? null))) {",
      "    globalThis.lastPointerPayload = { kind: \"original-ticket\", mismatches: [original.id !== assigned?.id ? \"id\" : null, (original.callAttemptId ?? null) !== (assigned?.callAttemptId ?? null) ? \"callAttemptId\" : null].filter(Boolean), window: { id: window.id, currentEntryId: window.currentEntryId ?? null, currentCallAttemptId: window.currentCallAttemptId ?? null }, original: { id: original.id, status: original.status, callAttemptId: original.callAttemptId ?? null, calledWindowId: original.calledWindowId ?? null }, assigned: assigned ? { id: assigned.id, status: assigned.status, callAttemptId: assigned.callAttemptId ?? null } : null };",
      "    console.error(\"RECONCILE DIAGNOSTIC DIFF\", JSON.stringify(globalThis.lastPointerPayload));",
      "    fail(\"Ticket snapshots disagree.\");",
      "  }"
    ].join("\n");
    if (!body.includes(assignedCheck)) throw new Error("Assigned ticket snapshot check not found for diagnostic.");
    body = body.replace(assignedCheck, assignedDiagnostic);
    if (!body.includes(originalCheck)) throw new Error("Original ticket snapshot check not found for diagnostic.");
    body = body.replace(originalCheck, originalDiagnostic);
    if (!body.includes(stabilityCheck)) throw new Error("Reconcile stability check not found for diagnostic.");
    body = body.replace(stabilityCheck, stabilityDiagnostic);
    // Active only while the instrumented reconcileAction wrapper is running.
    // The counter separates that reconciliation's first and second entry reads.
    body += `
async function getDocFromServer(target) {
  const script = globalThis.reconcileViewScript;
  const snapshot = await realGetDocFromServer(target);
  if (!script || !globalThis.reconcileViewActive || target.path !== script.path || !snapshot.exists()) return snapshot;
  const seen = (globalThis.reconcileViewReads = (globalThis.reconcileViewReads || 0) + 1);
  const data = snapshot.data();
  const view = value => ({ exists: () => true, id: snapshot.id, data: () => value });
  if (seen === 1 && script.mode === "restore-preclick-call") return view({ ...data, status: "in_progress", callAttemptId: script.callAttemptId, staffNeedMoreTimeAt: null, queueOrder: script.queueOrder ?? null });
  if (seen === 1) return view({ ...data, status: "called", confirmedPresentAt: null });
  if (seen === 2 && script.mode === "extra-call-attempt") return view({ ...data, callAttemptId: "reconcile-negative-attempt" });
  if (seen === 2 && script.mode === "restore-preclick-call" && script.foreignCalledWindowId) return view({ ...data, calledWindowId: script.foreignCalledWindowId });
  return snapshot;
}
`;
    await route.fulfill({ response, body });
  });
  const manager = await context.newPage(), staff = await context.newPage(), peer = await context.newPage();
  for (const [name, page] of [["manager", manager], ["staff", staff], ["peer", peer]]) {
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", msg => { const text = msg.text(); if (text.startsWith("RECONCILE DIAGNOSTIC")) console.error(name + " " + text); });
  }
  await manager.goto(origin + "/business.html"); await expect(manager.locator("#sessionStatus")).toHaveText("Queue session ready");
  const fixture = await manager.evaluate(async () => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const sid = await app.initializeTurnCue(), wid = await app.saveWindow(null, "Action Test", true), code = await app.registerStaff("Action Staff", "staff"), person = await app.findStaff(code), shift = await app.startShift(person.id, wid);
    for (let i=0;i<3;i++) await sdk.setDoc(sdk.doc(app.db,"queues",app.QUEUE_ID,"serviceSamples","pace-"+i), {businessId:app.BUSINESS_ID,locationId:app.LOCATION_ID,queueId:app.QUEUE_ID,sessionId:sid,entryId:"pace-"+i,windowId:wid,shiftId:shift,calledAt:sdk.Timestamp.fromMillis(Date.now()-600000),completedAt:sdk.serverTimestamp(),durationSeconds:null,durationMinutes:null,cleanEligible:true,exclusionReason:null,recordedAt:sdk.serverTimestamp()});
    return {sid,wid,shift,code,staffId:person.id};
  });
  await staff.clock.install();
  for (const page of [staff,peer]) { await page.goto(origin+"/staff.html"); await page.locator("#staffCode").fill(fixture.code); await page.locator("#entryForm button").click(); await page.locator("#confirmButton").click(); await expect(page.locator("#freshnessNotice")).toHaveAttribute("data-state","server-confirmed"); }
  const invoke = (name,args) => peer.evaluate(async ({name,args}) => (await import("/turncue.js"))[name](...args), {name,args});
  const state = () => manager.evaluate(async fixture => {
    const app=await import("/turncue.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const read=async (...segments)=>(await sdk.getDocsFromServer(sdk.collection(app.db,...segments))).docs.map(d=>({id:d.id,...d.data()}));
    return JSON.parse(JSON.stringify({entries:await read("sessions",fixture.sid,"entries"),windows:await read("windows"),shifts:await read("shifts"),samples:await read("queues",app.QUEUE_ID,"serviceSamples"),events:await read("windowEvents")}));
  },fixture);
  const button = (page,name) => page.getByRole("button",{name,exact:true});
  let sequence=0;
  async function newTicket(progress=false) {
    const snapshot=await state(), w=snapshot.windows.find(w=>w.id===fixture.wid);
    if(w.currentEntryId) await invoke("completeCustomer",[fixture.sid,w.currentEntryId,fixture.wid,w.currentShiftId,"staff",w.currentCallAttemptId]);
    if(w.state==="paused") await invoke("changeWindowState",[fixture.wid,w.currentShiftId,"resume"]);
    for(const entry of (await state()).entries.filter(e=>e.status==="waiting")) await invoke("transitionTicket",[fixture.sid,entry.id,"left_queue"]);
    const id="ticket-"+(++sequence);
    await manager.evaluate(async ({sid,id})=>{const app=await import("/turncue.js"),join=await import("/join-entry.js");await join.joinEntry(app.db,{businessId:app.BUSINESS_ID,locationId:app.LOCATION_ID,queueId:app.QUEUE_ID,sessionId:sid,entryId:id});}, {sid:fixture.sid,id});
    await invoke("callNext",[fixture.wid,fixture.shift,fixture.sid]);
    await expect(button(staff,"THEY'RE HERE")).toBeEnabled();
    if(progress) { await button(staff,"THEY'RE HERE").click(); await expect(button(staff,"COMPLETE & PAUSE")).toBeEnabled(); }
    return (await state()).entries.find(e=>e.id===id);
  }
  async function expectOutcome(page,allowUnresolved=false) {
    const result = () => page.evaluate(() => ({ outcome: document.getElementById("actionChecks").dataset.outcome, unresolved: document.getElementById("actionChecks").textContent.includes("Unable to confirm current state") }));
    await expect.poll(async () => { const state = await result(); return Boolean(state.outcome || state.unresolved); }, { timeout: 30000 }).toBe(true);
    const state = await result();
    if (allowUnresolved && state.unresolved) return state;
    assert.equal(state.unresolved, false, "Reconciliation could not confirm current state; no authoritative outcome was produced.");
    assert.ok(state.outcome, "Expected a successful authoritative reconciliation outcome.");
    return state;
  }
  async function fault(page,method,mode,name,holdRead=false,allowUnresolved=false) {
    await page.evaluate(({method,mode,holdRead})=>{globalThis.actionFault={method,mode};globalThis.failStateRead=holdRead;globalThis.faultReached=false;globalThis.faultCommitted=false;document.getElementById("actionChecks").dataset.outcome="";},{method,mode,holdRead});
    await button(page,name).click();
    await expect.poll(() => page.evaluate(() => globalThis.faultReached), { timeout: 30000 }).toBe(true);
    if(mode==="held") {await expect.poll(() => page.evaluate(() => globalThis.faultCommitted), { timeout: 30000 }).toBe(true); return;}
    if(holdRead) await expect(page.locator("#actionChecks")).toContainText("Unable to confirm current state");
    else return await expectOutcome(page,allowUnresolved);
  }
  async function finishHeld(page,allowUnresolved=false) {await page.evaluate(()=>releaseFault());return await expectOutcome(page,allowUnresolved);}
  let ticket=await newTicket(true), before=await state();
  await fault(staff,"resolveAndContinue","after","COMPLETE & PAUSE");
  let snapshot=await state(); assert.equal(snapshot.entries.find(e=>e.id===ticket.id).status,"completed"); assert.equal(snapshot.samples.length,before.samples.length+1);
  const completed=snapshot; await expect(staff.locator("#message")).toContainText("COMPLETED"); assert.deepEqual(await state(),completed);
  ticket=await newTicket(true); before=await state();
  await fault(staff,"resolveAndContinue","before","COMPLETE & PAUSE",true);
  await expect(button(staff,"COMPLETE & PAUSE")).toBeDisabled(); await expect(staff.locator(".lookup-number")).toBeEnabled(); assert.deepEqual(await state(),before);
  await staff.evaluate(()=>{globalThis.failStateRead=false;}); await button(staff,"Check current state").click();
  await expect(button(staff,"COMPLETE & PAUSE")).toBeEnabled(); assert.deepEqual(await state(),before);
  await button(staff,"COMPLETE & PAUSE").click();
  await expect(staff.locator("#message")).toHaveText("Ticket resolved. Window paused.");
  assert.equal((await state()).entries.find(e=>e.id===ticket.id).status,"completed");
  console.log("PASS completion lost acknowledgement/precommit/read failure, scoped blocking, explicit check/retry and one sample without replay");
  ticket=await newTicket(); const calledAt=ticket.calledAt;
  await staff.evaluate(path => { globalThis.reconcileViewScript = { path, mode: "called-then-authoritative" }; }, "sessions/" + fixture.sid + "/entries/" + ticket.id);
  await fault(staff,"transitionTicket","after","THEY'RE HERE"); snapshot=await state(); assert.equal(snapshot.entries.find(e=>e.id===ticket.id).status,"in_progress"); assert.deepEqual(snapshot.entries.find(e=>e.id===ticket.id).calledAt,calledAt);
  const positive = await staff.evaluate(() => ({ outcome: document.getElementById("actionChecks").dataset.outcome, diffs: globalThis.lastReconcileDiffs }));
  assert.equal(positive.diffs.length, 1);
  assert.equal(positive.diffs[0].path, "sessions/" + fixture.sid + "/entries/" + ticket.id);
  assert.deepEqual(positive.diffs[0].differences.map(item => item.field).sort(), ["confirmedPresentAt", "status"]);
  assert.deepEqual(positive.diffs[0].normalizedDifferences.map(item => item.field).sort(), ["confirmedPresentAt", "status"]);
  const positiveByField = Object.fromEntries(positive.diffs[0].differences.map(item => [item.field, item]));
  assert.equal(positiveByField.status.first, "called");
  assert.equal(positiveByField.status.second, "in_progress");
  assert.equal(positiveByField.confirmedPresentAt.first, null);
  assert.equal(positiveByField.confirmedPresentAt.second && positiveByField.confirmedPresentAt.second.type, "firestore/timestamp/1.0");
  assert.equal(typeof positiveByField.confirmedPresentAt.second.seconds, "number");
  assert.equal(positive.outcome, ticket.ticketLabel + ": IN_PROGRESS is recorded. No action was repeated.");
  await staff.evaluate(() => { globalThis.reconcileViewScript = null; });
  const beforeNegative = await state();
  const negative = await staff.evaluate(async saved => {
    globalThis.reconcileViewScript = { path: "sessions/" + saved.sessionId + "/entries/" + saved.id, mode: "extra-call-attempt" };
    const app = await import("/turncue.js");
    const context = app.captureAction("confirm_present", { id: saved.calledWindowId, currentShiftId: saved.calledByShiftId, currentStaffId: saved.calledByStaffId, state: "active" }, saved);
    try {
      await app.reconcileAction(context);
      return { accepted: true, diffs: globalThis.lastReconcileDiffs };
    } catch (error) {
      return { accepted: false, code: error.code, message: error.message, diffs: globalThis.lastReconcileDiffs };
    } finally { globalThis.reconcileViewScript = null; }
  }, ticket);
  assert.equal(negative.accepted, false);
  assert.equal(negative.code, "operation-blocked");
  assert.equal(negative.message, "State changed while checking. Check current state again.");
  assert.deepEqual(negative.diffs[0].differences.map(item => item.field).sort(), ["callAttemptId", "confirmedPresentAt", "status"]);
  const persisted = (await state()).entries.find(entry => entry.id === ticket.id);
  assert.deepEqual(persisted, beforeNegative.entries.find(entry => entry.id === ticket.id));
  assert.equal(persisted.status, "in_progress");
  assert.equal(persisted.callAttemptId, ticket.callAttemptId);
  assert.notEqual(persisted.callAttemptId, "reconcile-negative-attempt");
  assert.deepEqual(persisted.calledAt, calledAt);
  console.log("PASS deterministic confirm_present acceptance and extra callAttemptId fail-close");
  for(const mode of ["before","after"]) { ticket=await newTicket(true); before=await state(); await fault(staff,"transitionTicket",mode,"OPTED OUT"); snapshot=await state(); assert.equal(snapshot.entries.find(e=>e.id===ticket.id).status,mode==="before"?"in_progress":"opted_out"); if(mode==="before") assert.deepEqual(snapshot,before); }
  ticket=await newTicket(); await assert.rejects(invoke("resolveAndContinue",[fixture.sid,ticket.id,fixture.wid,fixture.shift,ticket.callAttemptId,"no_show","pause"]));
  await staff.clock.fastForward(121000); await expect(button(staff,"NO SHOW & PAUSE")).toBeVisible();
  const beforeNoShow = await state();
  const windowAssignment = snapshot => {
    const w = snapshot.windows.find(w=>w.id===fixture.wid);
    return { state:w.state, currentStaffId:w.currentStaffId, currentShiftId:w.currentShiftId, currentEntryId:w.currentEntryId, currentSessionId:w.currentSessionId, currentTicketLabel:w.currentTicketLabel, currentCallAttemptId:w.currentCallAttemptId, currentEntryCalledAt:w.currentEntryCalledAt };
  };
  const assertNoShowUnchanged = snapshot => {
    const current = snapshot.entries.find(e=>e.id===ticket.id);
    assert.equal(current.status,"called");
    assert.deepEqual(current,beforeNoShow.entries.find(e=>e.id===ticket.id));
    assert.deepEqual(windowAssignment(snapshot),windowAssignment(beforeNoShow));
  };
  const firstNoShowCheck = await fault(staff,"resolveAndContinue","before","NO SHOW & PAUSE",false,true);
  if (firstNoShowCheck.unresolved) {
    await expect(button(staff,"NO SHOW & PAUSE")).toBeDisabled();
    assertNoShowUnchanged(await state());
    await button(staff,"Check current state").click();
    await expect.poll(() => staff.evaluate(() => document.getElementById("actionChecks").dataset.outcome), { timeout: 30000, message: "Explicit Check current state must produce a new successful authoritative outcome; unresolved reconciliation is not success." }).toBeTruthy();
    await expectOutcome(staff);
  }
  assertNoShowUnchanged(await state());
  await expect(button(staff,"NO SHOW & PAUSE")).toBeEnabled();
  await fault(staff,"resolveAndContinue","after","NO SHOW & PAUSE"); assert.equal((await state()).entries.find(e=>e.id===ticket.id).status,"no_show");
  await staff.clock.setSystemTime(new Date());
  console.log("PASS presence reconciliation/unchanged clock, opted-out committed/failed results, no-show committed/failed results and arrival guard");
  ticket=await newTicket(true);
  await fault(staff,"transitionTicket","after","STAFF NEED MORE TIME"); snapshot=await state(); const moved=snapshot.entries.find(e=>e.id===ticket.id);
  assert.equal(moved.status,"waiting"); assert(moved.staffNeedMoreTimeAt); assert.equal(moved.callAttemptId,null); assert.equal(moved.customerNeedMoreTimeAt,undefined);
  assert.equal(ticket.status,"in_progress"); assert.ok(ticket.callAttemptId);
  const beforeDeferred = await state();
  const stored = (snapshot, name, id) => snapshot[name].find(item => item.id === id);
  const reconcileScripted = (saved, foreignCalledWindowId = null) => staff.evaluate(async ({ saved, foreignCalledWindowId }) => {
    globalThis.lastPointerPayload = null;
    globalThis.lastReconcileDiffs = [];
    globalThis.reconcileViewScript = { path: "sessions/" + saved.sessionId + "/entries/" + saved.id, mode: "restore-preclick-call", callAttemptId: saved.callAttemptId, queueOrder: saved.queueOrder ?? null, foreignCalledWindowId };
    const app = await import("/turncue.js");
    const context = app.captureAction("staff_need_more_time", { id: saved.calledWindowId, currentShiftId: saved.calledByShiftId, currentStaffId: saved.calledByStaffId, state: "active", currentEntryId: saved.id, currentCallAttemptId: saved.callAttemptId, currentSessionId: saved.sessionId }, saved);
    try {
      const state = await app.reconcileAction(context);
      return { accepted: true, outcome: state.outcome, payload: globalThis.lastPointerPayload, diffs: globalThis.lastReconcileDiffs, captured: { queueOrder: context.queueOrder, windowEntryId: context.windowEntryId, windowCallAttemptId: context.windowCallAttemptId, windowSessionId: context.windowSessionId, callAttemptId: context.callAttemptId, preStatus: context.preStatus, staffNeedMoreTimeAt: context.staffNeedMoreTimeAt } };
    } catch (error) {
      return { accepted: false, code: error.code, message: error.message, payload: globalThis.lastPointerPayload, diffs: globalThis.lastReconcileDiffs };
    } finally { globalThis.reconcileViewScript = null; }
  }, { saved: ticket, foreignCalledWindowId });
  const deferred = await reconcileScripted(ticket);
  assert.equal(deferred.accepted, true, deferred.message);
  assert.equal(deferred.payload, null);
  assert.equal(deferred.captured.preStatus, "in_progress");
  assert.equal(deferred.captured.staffNeedMoreTimeAt, null);
  assert.equal(deferred.captured.callAttemptId, ticket.callAttemptId);
  assert.equal(deferred.captured.queueOrder, ticket.queueOrder ?? null);
  assert.equal(deferred.captured.windowEntryId, ticket.id);
  assert.equal(deferred.captured.windowCallAttemptId, ticket.callAttemptId);
  assert.equal(deferred.captured.windowSessionId, ticket.sessionId);
  assert.equal(deferred.outcome, ticket.ticketLabel + ": staff Need More Time is recorded; current state is WAITING. No reposition was repeated.");
  const ticketDiff = deferred.diffs.find(item => item.path === "sessions/" + fixture.sid + "/entries/" + ticket.id);
  assert.ok(ticketDiff, "The deferred proof did not observe the scripted ticket read.");
  const diffFields = ticketDiff.differences.map(item => item.field).sort();
  for (const field of diffFields) assert.ok(["callAttemptId", "queueOrder", "staffNeedMoreTimeAt", "status"].includes(field), "Unexpected ticket difference " + field);
  assert.deepEqual(diffFields.filter(field => field !== "queueOrder"), ["callAttemptId", "staffNeedMoreTimeAt", "status"]);
  const byField = Object.fromEntries(ticketDiff.differences.map(item => [item.field, item]));
  assert.equal(byField.status.first, "in_progress");
  assert.equal(byField.status.second, "waiting");
  assert.equal(byField.callAttemptId.first, ticket.callAttemptId);
  assert.equal(byField.callAttemptId.second, null);
  assert.equal(byField.staffNeedMoreTimeAt.first, null);
  assert.equal(byField.staffNeedMoreTimeAt.second && byField.staffNeedMoreTimeAt.second.type, "firestore/timestamp/1.0");
  assert.equal(Number.isFinite(ticketDiff.second.queueOrder), true);
  assert.equal(ticketDiff.first.queueOrder ?? null, ticket.queueOrder ?? null);
  assert.equal(ticketDiff.first.calledWindowId, ticket.calledWindowId);
  assert.equal(ticketDiff.second.calledWindowId, ticket.calledWindowId);
  assert.equal(ticketDiff.second.callAttemptId, null);
  assert.equal(ticketDiff.second.status, "waiting");
  for (const diff of deferred.diffs) {
    if (diff.path === ticketDiff.path) continue;
    assert.equal(diff.path, "sessions/" + fixture.sid, "Unexpected document in the deferred proof: " + diff.path);
    assert.deepEqual(diff.differences.map(item => item.field).sort(), ["queueRevision"]);
  }
  const afterDeferred = await state();
  assert.deepEqual(stored(afterDeferred, "entries", ticket.id), stored(beforeDeferred, "entries", ticket.id));
  assert.deepEqual(stored(afterDeferred, "windows", fixture.wid), stored(beforeDeferred, "windows", fixture.wid));
  assert.deepEqual(stored(afterDeferred, "shifts", fixture.shift), stored(beforeDeferred, "shifts", fixture.shift));
  const beforeOwnership = await state();
  const ownership = await reconcileScripted(ticket, "foreign-window");
  assert.equal(ownership.accepted, false);
  assert.equal(ownership.code, "operation-blocked");
  assert.equal(ownership.message, "Ticket snapshots disagree.");
  assert.equal(ownership.payload, null);
  const ownershipDiff = ownership.diffs.find(item => item.path === "sessions/" + fixture.sid + "/entries/" + ticket.id);
  assert.ok(ownershipDiff);
  const ownershipByField = Object.fromEntries(ownershipDiff.differences.map(item => [item.field, item]));
  assert.equal(ownershipByField.calledWindowId.first, ticket.calledWindowId);
  assert.equal(ownershipByField.calledWindowId.second, "foreign-window");
  const afterNegative = await state();
  assert.deepEqual(stored(afterNegative, "entries", ticket.id), stored(beforeOwnership, "entries", ticket.id));
  assert.deepEqual(stored(afterNegative, "windows", fixture.wid), stored(beforeOwnership, "windows", fixture.wid));
  assert.deepEqual(stored(afterNegative, "shifts", fixture.shift), stored(beforeOwnership, "shifts", fixture.shift));
  assert.equal(stored(afterNegative, "entries", ticket.id).calledWindowId, ticket.calledWindowId);
  assert.notEqual(stored(afterNegative, "entries", ticket.id).calledWindowId, "foreign-window");
  assert.equal(stored(afterNegative, "entries", ticket.id).status, "waiting");
  assert.equal(stored(afterNegative, "entries", ticket.id).callAttemptId, null);
  assert.equal(stored(afterNegative, "windows", fixture.wid).currentEntryId, null);
  assert.equal(stored(afterNegative, "windows", fixture.wid).currentCallAttemptId, null);
  assert.equal(stored(afterNegative, "shifts", fixture.shift).currentEntryId, null);
  assert.equal(stored(afterNegative, "shifts", fixture.shift).currentSessionId, null);
  const clearedWindow = stored(beforeDeferred, "windows", fixture.wid);
  const clearedShift = stored(beforeDeferred, "shifts", fixture.shift);
  console.log("PASS deterministic staff_need_more_time deferred pointer " + JSON.stringify({
    firstPass: { ticket: { status: ticketDiff.first.status, callAttemptId: ticketDiff.first.callAttemptId, staffNeedMoreTimeAt: ticketDiff.first.staffNeedMoreTimeAt, queueOrder: ticketDiff.first.queueOrder ?? null, calledWindowId: ticketDiff.first.calledWindowId, calledByShiftId: ticketDiff.first.calledByShiftId, calledByStaffId: ticketDiff.first.calledByStaffId }, window: { id: clearedWindow.id, state: clearedWindow.state, currentEntryId: clearedWindow.currentEntryId ?? null, currentSessionId: clearedWindow.currentSessionId ?? null, currentCallAttemptId: clearedWindow.currentCallAttemptId ?? null, currentTicketLabel: clearedWindow.currentTicketLabel ?? null, currentEntryCalledAt: clearedWindow.currentEntryCalledAt ?? null, currentShiftId: clearedWindow.currentShiftId, currentStaffId: clearedWindow.currentStaffId }, shift: { id: clearedShift.id, currentEntryId: clearedShift.currentEntryId ?? null, currentSessionId: clearedShift.currentSessionId ?? null, state: clearedShift.state } },
    secondProof: { status: ticketDiff.second.status, callAttemptId: ticketDiff.second.callAttemptId, queueOrder: ticketDiff.second.queueOrder, calledWindowId: ticketDiff.second.calledWindowId, staffNeedMoreTimeAt: ticketDiff.second.staffNeedMoreTimeAt, otherDocuments: deferred.diffs.filter(item => item.path !== ticketDiff.path).map(item => ({ path: item.path, fields: item.differences.map(difference => difference.field) })) },
    outcome: deferred.outcome,
    negative: { message: ownership.message, payload: ownership.payload, returnedCalledWindowId: ownershipByField.calledWindowId.second, storedCalledWindowId: stored(afterNegative, "entries", ticket.id).calledWindowId }
  }));
  await invoke("callNext",[fixture.wid,fixture.shift,fixture.sid]);
  assert.equal(await peer.evaluate(async args => {
    const app = await import("/turncue.js");
    try { await app.transitionTicket(...args); }
    catch (error) {
      if (error.code !== "stale-call-attempt") throw error;
      return true;
    }
    throw new Error("Expected stale-call-attempt rejection.");
  }, [fixture.sid,ticket.id,"confirm_present",fixture.wid,fixture.shift,"staff",ticket.callAttemptId]), true);
  assert.deepEqual((await state()).entries.find(e=>e.id===ticket.id).queueOrder,moved.queueOrder);
  for(const outcome of ["completed","no_show"]) for(const after of ["next","pause"]) {
    ticket=await newTicket(outcome==="completed");
    const expectedNextId = after==="next" ? "next-"+crypto.randomUUID() : null;
    if(expectedNextId) await manager.evaluate(async ({sid,entryId})=>{const app=await import("/turncue.js"),join=await import("/join-entry.js");await join.joinEntry(app.db,{businessId:app.BUSINESS_ID,locationId:app.LOCATION_ID,queueId:app.QUEUE_ID,sessionId:sid,entryId});},{sid:fixture.sid,entryId:expectedNextId});
    if(outcome==="no_show") await staff.clock.fastForward(121000);
    const name=(outcome==="completed"?"COMPLETE":"NO SHOW")+" & "+(after==="next"?"CALL NEXT":"PAUSE");
    const pairedState = async () => ({ ...await state(), person: await manager.evaluate(async id => {
      const app=await import("/turncue.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
      return JSON.parse(JSON.stringify((await sdk.getDocFromServer(sdk.doc(app.db,"staff",id))).data()));
    },fixture.staffId) });
    const operationalPair = value => {
      const copy = structuredClone(value);
      for (const w of copy.windows) { delete w.lastPresenceAt; delete w.lastPresenceBrowserId; }
      return copy;
    };
    await expect(button(staff,name)).toBeVisible(); before=await pairedState();
    const original = before.entries.find(e=>e.id===ticket.id), owner = before.windows.find(w=>w.id===fixture.wid);
    assert.equal(owner.currentStaffId,fixture.staffId); assert.equal(owner.currentShiftId,fixture.shift);
    assert.equal(owner.currentEntryId,ticket.id); assert.equal(owner.currentCallAttemptId,original.callAttemptId);
    if(expectedNextId) assert.equal(before.entries.find(e=>e.id===expectedNextId).status,"waiting");
    const firstPairCheck = await fault(staff,"resolveAndContinue","after",name,false,true);
    const committedPair = await pairedState();
    const assertCommittedPair = current => {
      const resolved = current.entries.find(e=>e.id===ticket.id), terminalAt = outcome==="completed" ? "completedAt" : "noShowAt";
      assert.ok(resolved[terminalAt]);
      assert.deepEqual(resolved,{...original,status:outcome,[terminalAt]:resolved[terminalAt]});
      const w=current.windows.find(w=>w.id===fixture.wid), shift=current.shifts.find(s=>s.id===fixture.shift);
      assert.equal(w.active,owner.active); assert.equal(w.state,after==="pause"?"paused":"active");
      assert.equal(w.currentStaffId,owner.currentStaffId); assert.equal(w.currentShiftId,owner.currentShiftId);
      assert.equal(w.currentEntryId,expectedNextId); assert.equal(w.currentSessionId,expectedNextId?fixture.sid:null);
      assert.equal(shift.state,w.state); assert.equal(shift.endedAt,null);
      assert.equal(shift.staffId,owner.currentStaffId); assert.equal(shift.windowId,owner.id);
      assert.equal(shift.currentEntryId,w.currentEntryId); assert.equal(shift.currentSessionId,w.currentSessionId);
      assert.deepEqual(current.person,before.person);
      assert.equal(current.person.currentShiftId,fixture.shift); assert.equal(current.person.currentWindowId,fixture.wid);
      if(expectedNextId) {
        const next=current.entries.find(e=>e.id===expectedNextId);
        assert.equal(next.status,"called"); assert.ok(next.calledAt); assert.ok(next.callAttemptId);
        assert.equal(next.calledWindowId,w.id); assert.equal(next.calledByShiftId,w.currentShiftId); assert.equal(next.calledByStaffId,w.currentStaffId);
        assert.equal(next.sessionId,fixture.sid); assert.equal(w.currentTicketLabel,next.ticketLabel);
        assert.equal(w.currentCallAttemptId,next.callAttemptId); assert.deepEqual(w.currentEntryCalledAt,next.calledAt);
      } else { assert.equal(w.currentTicketLabel,null); assert.equal(w.currentCallAttemptId,null); assert.equal(w.currentEntryCalledAt,null); }
      assert.deepEqual(current.entries.filter(e=>e.id!==ticket.id && e.id!==expectedNextId),before.entries.filter(e=>e.id!==ticket.id && e.id!==expectedNextId));
      assert.equal(current.samples.length,before.samples.length+(outcome==="completed"?1:0));
      assert.deepEqual(current.samples.filter(s=>before.samples.some(old=>old.id===s.id)),before.samples);
      const addedSamples=current.samples.filter(s=>!before.samples.some(old=>old.id===s.id));
      if(outcome==="completed") {
        assert.equal(addedSamples.length,1); assert.equal(addedSamples[0].entryId,ticket.id);
        assert.equal(addedSamples[0].shiftId,fixture.shift); assert.equal(addedSamples[0].windowId,fixture.wid);
        assert.deepEqual(addedSamples[0].calledAt,original.calledAt); assert.deepEqual(addedSamples[0].completedAt,resolved.completedAt);
      } else assert.deepEqual(addedSamples,[]);
      assert.deepEqual(current.events.filter(e=>before.events.some(old=>old.id===e.id)),before.events);
      const addedEvents=current.events.filter(e=>!before.events.some(old=>old.id===e.id));
      assert.equal(addedEvents.length,2);
      assert.equal(addedEvents.filter(e=>e.type===(outcome==="completed"?"customer_completed":"customer_no_show") && e.entryId===ticket.id).length,1);
      assert.equal(addedEvents.filter(e=>expectedNextId ? e.type==="customer_called" && e.entryId===expectedNextId : e.type==="window_paused").length,1);
      assert.deepEqual(operationalPair(current),operationalPair(committedPair));
    };
    assertCommittedPair(committedPair);
    if(firstPairCheck.unresolved) {
      await expect(button(staff,expectedNextId?"PAUSE":"RESUME")).toBeDisabled();
      await expect(button(staff,"END SHIFT")).toBeDisabled();
      await button(staff,"Check current state").click();
      await expect.poll(() => staff.evaluate(() => document.getElementById("actionChecks").dataset.outcome), { timeout: 30000, message: "Explicit paired-action check must produce a new successful authoritative outcome; unresolved reconciliation is not success." }).toBeTruthy();
      await expectOutcome(staff);
    }
    await expect(staff.locator("#actionChecks")).toHaveAttribute("data-outcome",ticket.ticketLabel+": "+outcome.toUpperCase()+" is recorded. No action was repeated.");
    assertCommittedPair(await pairedState());
    await expect(button(staff,expectedNextId?"PAUSE":"RESUME")).toBeEnabled();
    if(expectedNextId) { await expect(button(staff,"THEY'RE HERE")).toBeEnabled(); await expect(button(staff,"END SHIFT")).toBeDisabled(); }
    else { await expect(button(staff,"END SHIFT")).toBeEnabled(); await expect(button(staff,"CALL NEXT")).toBeDisabled(); }
    await staff.clock.setSystemTime(new Date());
  }
  console.log("PASS staff allowance/fair requeue/stale attempt and all four atomic pairs without partial replay or duplicate samples");
  // Resolve the current ticket, leave an idle window with waiting customers.
  ticket=await newTicket(true); await button(staff,"COMPLETE & PAUSE").click(); await button(peer,"RESUME").click();
  await manager.evaluate(async sid=>{const app=await import("/turncue.js"),join=await import("/join-entry.js");for(const entryId of ["call-a","call-b"])await join.joinEntry(app.db,{businessId:app.BUSINESS_ID,locationId:app.LOCATION_ID,queueId:app.QUEUE_ID,sessionId:sid,entryId});},fixture.sid);
  await expect(button(staff,"CALL NEXT")).toBeEnabled();
  await fault(staff,"callNext","after","CALL NEXT"); snapshot=await state(); assert.equal(snapshot.entries.find(e=>e.id==="call-a").status,"called");assert.equal(snapshot.entries.find(e=>e.id==="call-b").status,"waiting");
  await invoke("completeCustomer",[fixture.sid,"call-a",fixture.wid,fixture.shift,"staff",snapshot.entries.find(e=>e.id==="call-a").callAttemptId]);
  await fault(staff,"callNext","held","CALL NEXT"); snapshot=await state(); const b=snapshot.entries.find(e=>e.id==="call-b");
  await invoke("completeCustomer",[fixture.sid,b.id,fixture.wid,fixture.shift,"staff",b.callAttemptId]); await finishHeld(staff);
  await expect(staff.locator("#message")).toContainText("earlier call result is unknown"); await expect(button(staff,"CALL NEXT")).toBeEnabled();
  assert.equal((await state()).entries.filter(e=>["called","in_progress"].includes(e.status)).length,0);
  const beforeHeldPause = await state();
  await fault(staff,"changeWindowState","held","PAUSE"); await button(peer,"RESUME").click();
  await expect.poll(async () => (await state()).windows.find(w=>w.id===fixture.wid).state, { timeout: 30000 }).toBe("active");
  const resumedPause = await state();
  const assertResumedPause = current => {
    const w = current.windows.find(w=>w.id===fixture.wid), shift = current.shifts.find(s=>s.id===fixture.shift);
    assert.equal(w.active,true); assert.equal(w.state,"active");
    assert.deepEqual(windowAssignment(current),windowAssignment(beforeHeldPause));
    assert.equal(w.lastEventId,resumedPause.windows.find(w=>w.id===fixture.wid).lastEventId);
    assert.equal(shift.state,"active"); assert.equal(shift.endedAt,null);
    assert.equal(shift.staffId,fixture.staffId); assert.equal(shift.windowId,fixture.wid);
    assert.equal(shift.currentEntryId,null); assert.equal(shift.currentSessionId,null);
    assert.deepEqual(current.entries,resumedPause.entries);
  };
  assertResumedPause(resumedPause);
  const firstPauseCheck = await finishHeld(staff,true);
  if (firstPauseCheck.unresolved) {
    assertResumedPause(await state());
    await expect(button(staff,"PAUSE")).toBeDisabled();
    await expect(button(staff,"CALL NEXT")).toBeDisabled();
    await expect(button(staff,"END SHIFT")).toBeDisabled();
    await button(staff,"Check current state").click();
    await expect.poll(() => staff.evaluate(() => document.getElementById("actionChecks").dataset.outcome), { timeout: 30000, message: "Explicit resumed-window check must produce a new successful authoritative outcome; unresolved reconciliation is not success." }).toBeTruthy();
    await expectOutcome(staff);
  }
  await expect(staff.locator("#actionChecks")).toHaveAttribute("data-outcome","Window is currently active. The earlier action was not replayed.");
  assertResumedPause(await state());
  await expect(button(staff,"PAUSE")).toBeEnabled();
  await button(peer,"PAUSE").click(); await fault(staff,"changeWindowState","after","RESUME"); await expect(button(staff,"PAUSE")).toBeEnabled();
  console.log("PASS CALL assignment/FIFO, intervening completion/idle new-decision policy, pause reversal and resume without automatic toggle");
  ticket=await newTicket(true); before=await state(); await manager.evaluate(()=>{globalThis.actionFault={method:"completeCustomer",mode:"after"};document.getElementById("actionChecks").dataset.outcome="";});
  await manager.locator("#windows").getByRole("button",{name:"COMPLETE "+ticket.ticketLabel,exact:true}).click(); await manager.waitForFunction(()=>Boolean(document.getElementById("actionChecks").dataset.outcome));
  snapshot=await state(); assert.equal(snapshot.entries.find(e=>e.id===ticket.id).status,"completed"); assert.equal(snapshot.samples.length,before.samples.length+1);
  staff.on("dialog",dialog=>dialog.accept());
  await fault(staff,"changeWindowState","held","END SHIFT");
  const replacement=await invoke("startShift",[fixture.staffId,fixture.wid]);
  assert.notEqual(replacement,fixture.shift);
  const replacementBaseline = await state();
  const completedBeforeReplacement = snapshot.entries.find(e=>e.id===ticket.id);
  const originalEndedShift = replacementBaseline.shifts.find(s=>s.id===fixture.shift);
  async function assertReplacementOwnership(current) {
    const w = current.windows.find(w=>w.id===fixture.wid), shift = current.shifts.find(s=>s.id===replacement), old = current.shifts.find(s=>s.id===fixture.shift);
    assert.equal(w.currentShiftId,replacement); assert.equal(w.currentStaffId,fixture.staffId);
    assert.equal(w.active,true); assert.equal(w.state,"active");
    assert.equal(w.currentEntryId,null); assert.equal(w.currentSessionId,null);
    assert.equal(w.currentTicketLabel,null); assert.equal(w.currentCallAttemptId,null);
    assert.equal(shift.endedAt,null); assert.equal(shift.state,"active");
    assert.equal(shift.windowId,fixture.wid); assert.equal(shift.staffId,fixture.staffId);
    assert.equal(shift.currentEntryId,null); assert.equal(shift.currentSessionId,null);
    assert.equal(old.state,"ended"); assert.ok(old.endedAt); assert.deepEqual(old,originalEndedShift);
    const person = await manager.evaluate(async staffId => {
      const app=await import("/turncue.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
      return (await sdk.getDocFromServer(sdk.doc(app.db,"staff",staffId))).data();
    },fixture.staffId);
    assert.equal(person.currentShiftId,replacement); assert.equal(person.currentWindowId,fixture.wid);
    assert.deepEqual(current.entries.find(e=>e.id===ticket.id),completedBeforeReplacement);
  }
  await assertReplacementOwnership(replacementBaseline);
  const firstEndCheck = await finishHeld(staff,true);
  if (firstEndCheck.unresolved) {
    await assertReplacementOwnership(await state());
    await expect(button(staff,"END SHIFT")).toBeDisabled();
    await expect(button(staff,"PAUSE")).toBeDisabled();
    await expect(staff.locator(".lookup-number")).toBeEnabled();
    await button(staff,"Check current state").click();
    await expect.poll(() => staff.evaluate(() => document.getElementById("actionChecks").dataset.outcome), { timeout: 30000, message: "Explicit replacement ownership check must produce a new successful authoritative outcome; unresolved reconciliation is not success." }).toBeTruthy();
    await expectOutcome(staff);
  }
  await expect(staff.locator("#actionChecks")).toHaveAttribute("data-outcome","The original shift has ended. Current ownership is shown.");
  await expect(button(staff,"END SHIFT")).toBeEnabled();
  await expect(button(staff,"PAUSE")).toBeEnabled();
  await assertReplacementOwnership(await state());
  await assert.rejects(invoke("changeWindowState",[fixture.wid,fixture.shift,"end"]));
  await assert.rejects(invoke("transitionTicket",[fixture.sid,ticket.id,"opted_out",fixture.wid,fixture.shift,"staff",ticket.callAttemptId]));
  await assertReplacementOwnership(await state());
  console.log("PASS representative manager completion, original ended-shift reconciliation, replacement ownership and stale operation rejection");
  // Lose Firestore transport after a committed PAUSE, retain context until reads resume.
  await expect(button(staff,"PAUSE")).toBeEnabled();
  const subscriptions=await staff.evaluate(()=>subscriptionStarts);
  await fault(staff,"changeWindowState","held","PAUSE");
  await staff.evaluate(async ()=>{const {db}=await import("/firebase-client.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");await sdk.disableNetwork(db);globalThis.failStateRead=true;});
  await staff.evaluate(()=>releaseFault()); await expect(staff.locator("#actionChecks")).toContainText("Unable to confirm current state");
  await expect(button(staff,"RESUME")).toBeDisabled();
  await staff.evaluate(async ()=>{const {db}=await import("/firebase-client.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");await sdk.enableNetwork(db);globalThis.failStateRead=false;});
  await expect.poll(() => staff.evaluate(async ({wid,staffId,shiftId}) => {
    const {db}=await import("/firebase-client.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    try {
      const snapshot=await sdk.getDocFromServer(sdk.doc(db,"windows",wid));
      return snapshot.exists() && snapshot.data().currentStaffId===staffId && snapshot.data().currentShiftId===shiftId;
    } catch (_) { return false; }
  }, {wid:fixture.wid,staffId:fixture.staffId,shiftId:replacement}), { timeout: 30000 }).toBe(true);
  await button(staff,"Check current state").click(); await expect(button(staff,"RESUME")).toBeEnabled();
  assert.equal(await staff.evaluate(()=>subscriptionStarts),subscriptions);
  assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
  console.log("PASS network-loss context preservation, explicit server-backed check, unchanged subscriptions and no unexpected traffic/errors");
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
