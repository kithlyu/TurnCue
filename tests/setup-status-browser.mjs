// Manager setup detection on the real manager page. No production requests.
import assert from "node:assert/strict";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";

const assets = process.env.TURNCUE_TEST_ASSETS;
assert(assets, "Set TURNCUE_TEST_ASSETS to the pinned local SDK folder.");
const emulator = "http://127.0.0.1:8787";
const sdk = "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
const existingProject = testProject("setup-existing");
const freshProject = testProject("setup-fresh");
await compileRules(existingProject);
await compileRules(freshProject);
const existingServer = await startBrowserServer(existingProject);
const freshServer = await startBrowserServer(freshProject);
const existingOrigin = "http://127.0.0.1:" + existingServer.address().port;
const freshOrigin = "http://127.0.0.1:" + freshServer.address().port;
let browser;
const errors = [];

function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  return { stringValue: value };
}
async function seed(project, documentPath, values) {
  const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encode(value)]));
  const result = await fetch(emulator + "/v1/projects/" + project + "/databases/(default)/documents/" + documentPath, {
    method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields })
  });
  assert(result.ok, await result.text());
}
async function routeRequest(route, origin, allowEmulator) {
  const url = new URL(route.request().url());
  if (url.origin === origin) return route.continue();
  if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) {
    return route.fulfill({ path: path.join(assets, path.basename(url.pathname)), contentType: "text/javascript" });
  }
  if (allowEmulator(url, route.request())) return route.continue();
  return route.abort();
}
async function routeApp(context, origin) {
  await context.route("**/*", route => routeRequest(route, origin, url => url.origin === emulator));
}
async function openManager(origin) {
  const context = await browser.newContext();
  await routeApp(context, origin);
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin + "/business.html");
  return { context, page };
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.TURNCUE_TEST_BROWSER || undefined });
  const scope = { businessId: "demo-business", locationId: "main-location", queueId: "main-queue" };
  await seed(existingProject, "businesses/demo-business", { name: "TurnCue Demo Business", active: true });
  await seed(existingProject, "locations/main-location", { businessId: "demo-business", name: "Main Location", active: true });
  await seed(existingProject, "sessions/existing-session", { ...scope, status: "open", ticketPrefix: "A", nextTicketNumber: 140 });
  await seed(existingProject, "queues/main-queue", { businessId: "demo-business", locationId: "main-location", name: "Main Queue", active: true, currentSessionId: "existing-session", ticketPrefix: "A", ticketStart: 101 });
  await seed(existingProject, "staff/existing-staff", { businessId: "demo-business", staffCode: "TC-EXISTING", name: "Existing Staff", role: "staff", active: false, currentShiftId: null, currentWindowId: null });
  await seed(existingProject, "windows/existing-window", { ...scope, name: "Window 1", active: false, state: "inactive", retired: true, currentStaffId: null, currentShiftId: null, currentEntryId: null, currentSessionId: null, currentTicketLabel: null });

  const existing = await openManager(existingOrigin);
  await expect(existing.page.locator("#firstUse")).toHaveAttribute("data-setup", "complete", { timeout: 20000 });
  await expect(existing.page.locator("#firstUse")).toBeHidden();
  await expect(existing.page.locator("#firstUseSteps")).toBeEmpty();
  await expect(existing.page.locator("#sessionStatus")).toHaveText("Queue session ready");
  await expect(existing.page.locator("#sessionDetail")).toHaveText("Operational session: existing-session");
  await expect(existing.page.locator("#roster")).toContainText("Existing Staff");
  await expect(existing.page.locator("#roster")).toContainText("Inactive");
  await expect(existing.page.locator("#windows")).toHaveText("Add a window, then ask staff to choose it on Start Shift.");
  await expect(existing.page.locator("#waitingTitle")).toBeVisible();
  await expect(existing.page.locator("#assistedIssuance")).toBeVisible();
  await expect(existing.page.locator("#ticketLookup")).toBeVisible();
  await existing.page.reload();
  await expect(existing.page.locator("#firstUse")).toHaveAttribute("data-setup", "complete", { timeout: 20000 });
  await expect(existing.page.locator("#sessionDetail")).toHaveText("Operational session: existing-session");
  const sessions = await existing.page.evaluate(async sdkUrl => {
    const app = await import("/turncue.js");
    const { getDocs, collection } = await import(sdkUrl);
    return (await getDocs(collection(app.db, "sessions"))).docs.map(doc => doc.id);
  }, sdk);
  assert.deepEqual(sessions, ["existing-session"]);
  console.log("PASS existing inactive staff and retired window stay set up on one session");
  await existing.context.close();

  const fresh = await openManager(freshOrigin);
  const manager = fresh.page;
  await expect(manager.locator("#firstUse")).toHaveAttribute("data-setup", "incomplete", { timeout: 20000 });
  await expect(manager.locator("#firstUse")).toBeVisible();
  await expect(manager.locator("#firstUseIntro")).toContainText("does not mean someone has started a shift");
  await expect(manager.locator("#firstUseNext")).toHaveText("Next: register a staff member, then add a window. The queue session is already open.");
  await expect(manager.locator('#firstUseSteps [data-step="session"]')).toHaveAttribute("data-state", "done");
  await expect(manager.locator('#firstUseSteps [data-step="staff"]')).toHaveAttribute("data-state", "next");
  await expect(manager.locator('#firstUseSteps [data-step="staff"]')).toHaveAttribute("aria-current", "step");
  await expect(manager.locator('#firstUseSteps [data-step="staff"]')).toContainText("Register a person in the staff roster below.");
  await expect(manager.locator('#firstUseSteps [data-step="windows"]')).toHaveAttribute("data-state", "later");
  await expect(manager.locator("#firstUseAction")).toHaveText("REGISTER A STAFF MEMBER");
  await expect(manager.locator("#firstUseAction")).toBeEnabled();
  await manager.setViewportSize({ width: 390, height: 844 });
  const phoneCard = await manager.locator("#firstUse").boundingBox();
  assert(phoneCard && phoneCard.x >= 0 && phoneCard.x + phoneCard.width <= 391, "setup guide overflows the phone width");
  await expect(manager.locator("#firstUseAction")).toBeVisible();
  await manager.setViewportSize({ width: 1280, height: 800 });
  await expect(manager.locator("#sessionStatus")).toHaveText("Queue session ready");
  await expect(manager.locator("#staffForm button")).toBeEnabled();
  await expect(manager.locator("#addWindows")).toBeEnabled();
  await expect(manager.locator("#waitingTitle")).toBeVisible();
  await expect(manager.locator("#assistedIssuance")).toBeVisible();
  await expect(manager.locator("#ticketLookup")).toBeVisible();
  await fresh.context.setOffline(true);
  await expect(manager.locator("#firstUse")).toHaveAttribute("data-setup", "unknown");
  await expect(manager.locator("#firstUse")).toBeHidden();
  await expect(manager.locator("#firstUseNext")).toHaveText("");
  await expect(manager.locator("#firstUseSteps")).toBeEmpty();
  await expect(manager.locator("#sessionStatus")).toHaveText("Queue session ready");
  await fresh.context.setOffline(false);
  await manager.reload();
  await expect(manager.locator("#firstUse")).toHaveAttribute("data-setup", "incomplete", { timeout: 20000 });
  await manager.locator("#firstUseAction").click();
  await expect(manager.locator("#staffName")).toBeFocused();
  await manager.locator("#staffName").fill("Setup Staff");
  await manager.locator("#staffRole").selectOption("staff");
  await manager.locator("#staffForm button").click();
  await expect(manager.locator("#message")).toContainText("Registered Setup Staff");
  await expect(manager.locator("#firstUseNext")).toHaveText("Next: add a window, then ask staff to choose it on Start Shift.", { timeout: 20000 });
  await expect(manager.locator('#firstUseSteps [data-step="staff"]')).toHaveAttribute("data-state", "done");
  await expect(manager.locator('#firstUseSteps [data-step="staff"]')).toContainText("A staff record is saved.");
  await expect(manager.locator('#firstUseSteps [data-step="windows"]')).toHaveAttribute("data-state", "next");
  await expect(manager.locator('#firstUseSteps [data-step="windows"]')).toHaveAttribute("aria-current", "step");
  await expect(manager.locator("#firstUseAction")).toHaveText("ADD WINDOWS");
  await manager.locator("#firstUseAction").click();
  await expect(manager.locator("#addWindowsModal")).toBeVisible();
  await manager.locator("#bulkMode").selectOption("numbered");
  await manager.locator("#bulkQuantity").fill("1");
  await expect(manager.locator("#bulkPreview")).toContainText("Window 1");
  await manager.locator("#bulkCreate").click();
  await expect(manager.locator("#message")).toContainText("Created: Window 1.");
  await expect(manager.locator("#firstUse")).toHaveAttribute("data-setup", "complete", { timeout: 20000 });
  await expect(manager.locator("#firstUse")).toBeHidden();
  await expect(manager.locator("#firstUseSteps")).toBeEmpty();
  await expect(manager.locator("#sessionStatus")).toHaveText("Queue session ready");
  await expect(manager.locator("#roster")).toContainText("Setup Staff");
  await expect(manager.locator("#windows")).toContainText("Window 1");
  await expect(manager.locator("#windows")).toContainText("No staff assigned");
  const sessionDetail = await manager.locator("#sessionDetail").textContent();
  await manager.reload();
  await expect(manager.locator("#firstUse")).toHaveAttribute("data-setup", "complete", { timeout: 20000 });
  await expect(manager.locator("#sessionStatus")).toHaveText("Queue session ready");
  await expect(manager.locator("#sessionDetail")).toHaveText(sessionDetail);
  await expect(manager.locator("#windows")).toContainText("Window 1");
  console.log("PASS incomplete setup leads into the current manager dashboard and stays complete");

  const failed = await browser.newContext();
  let allowedReachability = false;
  await failed.route("**/*", route => routeRequest(route, freshOrigin, (url, request) => {
    if (url.origin !== emulator || allowedReachability || request.method() !== "GET" || !url.pathname.endsWith("/documents/queues/main-queue")) return false;
    allowedReachability = true;
    return true;
  }));
  const failedPage = await failed.newPage();
  failedPage.on("pageerror", error => errors.push("failed-read: " + error.message));
  await failedPage.goto(freshOrigin + "/business.html");
  await expect(failedPage.locator("#sessionStatus")).toHaveText("Unable to initialize TurnCue", { timeout: 20000 });
  await expect(failedPage.locator("#firstUse")).toHaveAttribute("data-setup", "unknown");
  await expect(failedPage.locator("#firstUse")).toBeHidden();
  await expect(failedPage.locator("#firstUseNext")).toHaveText("");
  await expect(failedPage.locator("#firstUseSteps")).toBeEmpty();
  console.log("PASS unavailable setup reads stay unknown");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise(resolve => existingServer.close(resolve));
  await new Promise(resolve => freshServer.close(resolve));
}
