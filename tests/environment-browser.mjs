// Tests local runtime behavior in an isolated project with real SDKs; external requests are blocked.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
const assets = process.env.TURNCUE_TEST_ASSETS;
assert(assets, "Set TURNCUE_TEST_ASSETS to the pinned local SDK folder.");
const project = testProject("environment");
await compileRules(project);
const server = await startBrowserServer(project);
console.log("PASS current checkout rules compile in isolated browser project");
const origin = "http://127.0.0.1:" + server.address().port;
const emulator = "http://127.0.0.1:8787";
let browser;
const external = [], errors = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.TURNCUE_TEST_BROWSER || undefined });
  async function contextFor(emulatorAvailable = true) {
    const context = await browser.newContext();
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      if (url.origin === emulator) {
        assert(!url.pathname.includes("turncue-83e1a"), "No production project requests, even on emulator");
        return emulatorAvailable ? route.continue() : route.abort();
      }
      if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) {
        return route.fulfill({ path: path.join(assets, path.basename(url.pathname)), contentType: "text/javascript" });
      }
      external.push(url.href);
      return route.abort();
    });
    return context;
  }
  const context = await contextFor();
  const identities = [];
  let customer;
  for (const file of ["business.html", "staff.html", "index.html"]) {
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    if (file === "index.html") {
      // Old local sessions could contain a production ticket. It must be ignored.
      await page.addInitScript(() => localStorage.setItem("turncue_active_entry", JSON.stringify({ sessionId: "production-only", entryId: "must-not-read" })));
      customer = page;
    }
    await page.goto(origin + "/" + file);
    identities.push(await page.evaluate(async () => {
      const { db, environment } = await import("/firebase-client.js");
      return { environment, projectId: db.app.options.projectId };
    }));
    if (file === "business.html") await page.waitForFunction(() => document.getElementById("sessionStatus").textContent === "Queue session ready");
    assert.equal(await page.locator("#environmentError").count(), 0);
  }
  assert.deepEqual(identities[0], identities[1]);
  assert.deepEqual(identities[1], identities[2]);
  assert.equal(identities[0].projectId, project);
  const entryKey = identities[0].environment.storagePrefix + ":active_entry";
  await customer.locator("#joinButton").click();
  await customer.waitForFunction(key => Boolean(localStorage.getItem(key)), entryKey);
  await customer.waitForFunction(() => document.getElementById("ticketNumber").textContent.startsWith("A"));
  const saved = await customer.evaluate(key => localStorage.getItem(key), entryKey);
  const ticket = await customer.locator("#ticketNumber").textContent();
  await customer.reload();
  await customer.waitForFunction(() => document.getElementById("queueScreen").style.display !== "none" && document.getElementById("ticketNumber").textContent.startsWith("A"));
  assert.equal(await customer.evaluate(key => localStorage.getItem(key), entryKey), saved);
  assert.equal(await customer.locator("#ticketNumber").textContent(), ticket);
  console.log("PASS all three pages share demo environment/scope; customer ignores legacy local key and recovers the same ticket after reload");
  await context.close();

  const offline = await contextFor(false);
  for (const file of ["index.html", "business.html", "staff.html"]) {
    const page = await offline.newPage();
    await page.goto(origin + "/" + file);
    await page.locator("#environmentError").waitFor();
    assert.match(await page.locator("#environmentError").textContent(), /emulator unavailable.*Production fallback is disabled/);
  }
  await offline.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], "Unexpected external traffic (blocked)");
  console.log("PASS emulator outage visible on all three pages; no production fallback or live Firestore requests");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
