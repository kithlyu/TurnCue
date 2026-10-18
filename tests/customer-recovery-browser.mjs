import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project = testProject("recovery-ui");
await compileRules(project);
const server = await startBrowserServer(project), origin = "http://127.0.0.1:" + server.address().port;
const emulator = "http://127.0.0.1:8787", errors = [], external = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let recoveryDelay = null;
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    const delay = recoveryDelay;
    if (delay && route.request().frame().page() === delay.page && delay.matches(url)
      && route.request().method() === "POST") {
      const body = decodeURIComponent(route.request().postData() || "");
      if (!delay.held && body.includes("addTarget") && body.includes(delay.ticketPath)) {
        delay.held = true; delay.reached();
        await delay.gate;
      }
    }
    if ([origin, emulator].includes(url.origin)) return route.continue();
    if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) return route.fulfill({ path: path.join(process.env.TURNCUE_TEST_ASSETS, path.basename(url.pathname)), contentType: "text/javascript" });
    external.push(url.href); return route.abort();
  });
  const manager = await context.newPage(), customer = await context.newPage();
  for (const page of [manager, customer]) page.on("pageerror", e => errors.push(e.message));
  await manager.goto(origin + "/staff.html");
  const fixture = await manager.evaluate(async () => {
    const app = await import("/turncue.js");
    const sid = await app.initializeTurnCue(), wid = await app.saveWindow(null, "Recovery Test", true), code = await app.registerStaff("Recovery Staff", "staff");
    return { sid, wid, shift: await app.startShift((await app.findStaff(code)).id, wid) };
  });
  const invoke = (name, args) => manager.evaluate(async ({ name, args }) => (await import("/turncue.js"))[name](...args), { name, args });
  const saved = () => customer.evaluate(async () => {
    const { environment } = await import("/firebase-client.js");
    return JSON.parse(localStorage.getItem(environment.storagePrefix + ":active_entry"));
  });
  let id;
  const read = () => manager.evaluate(async ({ sid, id }) => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const t = (await sdk.getDocFromServer(sdk.doc(app.db, "sessions", sid, "entries", id))).data();
    return { status: t.status, ticketLabel: t.ticketLabel, joinedAt: t.joinedAt.toMillis(), calledAt: t.calledAt?.toMillis() ?? null, callAttemptId: t.callAttemptId ?? null };
  }, { sid: fixture.sid, id });
  const counter = () => manager.evaluate(async sid => {
    const app = await import("/turncue.js"), sdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    return (await sdk.getDocFromServer(sdk.doc(app.db, "sessions", sid))).data().nextTicketNumber;
  }, fixture.sid);
  async function join() {
    await customer.locator("#joinButton").click();
    await expect.poll(saved).not.toBeNull(); id = (await saved()).entryId;
    await expect(customer.locator("#waitingMessage")).toBeVisible();
    await expect(customer.locator("#ticketNumber")).toHaveText((await read()).ticketLabel);
  }
  await customer.goto(origin + "/index.html"); await join();
  const marker = await saved(), waiting = await read(), nextNumber = await counter();
  await customer.reload(); await expect(customer.locator("#waitingMessage")).toBeVisible();
  assert.deepEqual(await saved(), marker); assert.deepEqual(await read(), waiting);
  // Hold the ticket RPC, without a sleep or delaying the page's own loading UI.
  let release, sawRequest;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { sawRequest = resolve; });
  const recoveryListen = url => url.origin === emulator
    && url.pathname.endsWith("/google.firestore.v1.Firestore/Listen/channel")
    && url.searchParams.get("database") === `projects/${project}/databases/(default)`;
  recoveryDelay = { page: customer, matches: recoveryListen, ticketPath: `/sessions/${fixture.sid}/entries/${id}`, held: false, reached: sawRequest, gate };
  await customer.reload(); await reached;
  await expect(customer.locator("#loadingScreen")).toBeVisible();
  await expect(customer.locator("#joinButton")).toBeDisabled();
  await expect(customer.locator("#queueScreen")).toBeHidden();
  assert.deepEqual(await saved(), marker);
  release();
  recoveryDelay = null;
  await expect(customer.locator("#waitingMessage")).toBeVisible();
  console.log("PASS WAITING recovery and delayed restore blocks JOIN without placeholder content");

  const rules = fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
  const entryStart = rules.indexOf("match /entries/{entryId}");
  const deny = rules.slice(0, entryStart) + rules.slice(entryStart).replace("allow read: if true;", "allow read: if false;");
  const response = await fetch(`${emulator}/emulator/v1/projects/${project}:securityRules`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content: deny }] } })
  });
  assert(response.ok);
  await customer.reload();
  await expect(customer.locator("#retryRecoveryButton")).toBeVisible();
  await expect(customer.locator("#joinButton")).toBeDisabled(); assert.deepEqual(await saved(), marker);
  await compileRules(project);
  await customer.locator("#retryRecoveryButton").click(); await expect(customer.locator("#waitingMessage")).toBeVisible();
  assert.equal(await counter(), nextNumber);
  console.log("PASS failed restore preserves marker, retry restores same ticket and no duplicate JOIN occurs");

  await invoke("callNext", [fixture.wid, fixture.shift, fixture.sid]);
  await expect(customer.locator("#imHereButton")).toBeVisible(); const called = await read();
  await customer.reload(); await expect(customer.locator("#imHereButton")).toBeVisible();
  await expect(customer.locator("#calledTicket")).toHaveText(called.ticketLabel);
  assert.deepEqual(await read(), called); assert.deepEqual(await saved(), marker);
  await assert.rejects(invoke("transitionTicket", [fixture.sid, id, "confirm_present", fixture.wid, fixture.shift, "customer", "stale-attempt"]));
  await customer.locator("#imHereButton").click(); await expect(customer.locator("#calledTitle")).toHaveText("Service in progress");
  const progress = await read(); assert.equal(progress.calledAt, called.calledAt);
  await customer.reload(); await expect(customer.locator("#calledTitle")).toHaveText("Service in progress");
  await expect(customer.locator("#imHereButton")).toBeHidden(); assert.deepEqual(await read(), progress);
  await invoke("resolveAndContinue", [fixture.sid, id, fixture.wid, fixture.shift, called.callAttemptId, "completed", "pause"]);
  await expect(customer.locator("#completedScreen")).toBeVisible();
  const summary = await customer.locator(".summary").textContent();
  await customer.reload(); await expect(customer.locator("#completedScreen")).toBeVisible();
  await expect(customer.locator("#completedTicket")).toContainText(called.ticketLabel);
  assert.equal(await customer.locator(".summary").textContent(), summary);
  assert.equal((await read()).status, "completed"); assert.equal(await counter(), nextNumber);
  await customer.locator("#backHomeButton").click(); assert.equal(await saved(), null);
  console.log("PASS CALLED/IN_PROGRESS recovery, stale attempt protection, unchanged calledAt and COMPLETED summary persistence");

  await invoke("changeWindowState", [fixture.wid, fixture.shift, "resume"]);
  for (const outcome of ["no_show", "opted_out", "left_queue"]) {
    await join(); const ticket = await read();
    if (outcome === "left_queue") {
      await customer.locator("#leaveButton").click(); await customer.locator("#confirmLeaveButton").click();
    } else {
      await invoke("callNext", [fixture.wid, fixture.shift, fixture.sid]);
      await expect(customer.locator("#imHereButton")).toBeVisible(); const t = await read();
      await invoke("transitionTicket", [fixture.sid, id, outcome, fixture.wid, fixture.shift, "staff", t.callAttemptId]);
    }
    await expect(customer.locator("#cancelledScreen")).toBeVisible();
    const title = await customer.locator("#cancelledScreen .complete-title").textContent();
    const terminalMarker = await saved(), terminal = await read(), count = await counter();
    await customer.reload(); await expect(customer.locator("#cancelledScreen")).toBeVisible();
    await expect(customer.locator("#exitTicket")).toContainText(ticket.ticketLabel);
    await expect(customer.locator("#cancelledScreen .complete-title")).toHaveText(title);
    assert.deepEqual(await saved(), terminalMarker); assert.deepEqual(await read(), terminal); assert.equal(await counter(), count);
    await expect(customer.locator("#imHereButton")).toBeHidden();
    await customer.locator("#cancelledHomeButton").click(); assert.equal(await saved(), null);
  }
  // A server-confirmed absent document is the definitive unrecoverable case.
  await customer.evaluate(async sid => {
    const { environment } = await import("/firebase-client.js");
    localStorage.setItem(environment.storagePrefix + ":active_entry", JSON.stringify({ sessionId: sid, entryId: "absent-ticket" }));
  }, fixture.sid);
  await customer.reload(); await expect(customer.locator("#joinButton")).toBeVisible();
  await expect(customer.locator("#errorMessage")).toContainText("no longer exists"); assert.equal(await saved(), null);
  await expect(customer.locator("#connectionNotice")).toHaveAttribute("data-state", "connected");
  await expect(customer.locator("#connectionNotice")).toBeHidden();
  await expect(customer.locator("#joinButton")).toBeEnabled();
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS all exit-state refreshes remain terminal; dismissal and confirmed absence restore normal JOIN");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
