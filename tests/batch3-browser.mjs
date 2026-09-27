// Local-only browser/Firestore integration tests. No production requests allowed.
// Requires Playwright, Chrome/Edge, and the Firestore emulator on 127.0.0.1:8787.
// Set TURNCUE_TEST_ASSETS to a folder containing the two Firebase 12.19.0 SDK files.
// NODE_PATH may point to an existing Playwright installation; no app dependency.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = process.env.TURNCUE_TEST_ASSETS;
assert(assets, "Set TURNCUE_TEST_ASSETS to the local SDK folder.");
const project = "demo-turncue-browser-" + Date.now();
const emulator = "http://127.0.0.1:8787";
const api = emulator + "/v1/projects/" + project + "/databases/(default)/documents";
const sdk = "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
const scope = { businessId: "demo-business", locationId: "main-location", queueId: "main-queue" };
let checks = 0;
function passed(name) { checks++; console.log("PASS " + name); }

for (const file of ["index.html", "business.html", "staff.html", "turncue.js"]) {
  const content = fs.readFileSync(path.join(root, file), "utf8");
  const scripts = file.endsWith(".html") ? [...content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]) : [content];
  for (const source of scripts) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source, encoding: "utf8" });
    assert.equal(result.status, 0, file + ": " + result.stderr);
  }
}
JSON.parse(fs.readFileSync(path.join(root, "firestore.indexes.json"), "utf8").replace(/^\uFEFF/, ""));
passed("all JavaScript syntax and index JSON");

const rulesResponse = await fetch(emulator + "/emulator/v1/projects/" + project + ":securityRules", {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content: fs.readFileSync(path.join(root, "firestore.rules"), "utf8").replace(/^\uFEFF/, "") }] } })
});
const ruleText = await rulesResponse.text();
assert(rulesResponse.ok, ruleText);
assert(!JSON.parse(ruleText).issues?.some(x => x.severity === "ERROR"), ruleText);
passed("current Firestore rules compile in the emulator");

const server = http.createServer((request, response) => {
  const file = decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1) || "index.html";
  if (!["index.html", "business.html", "staff.html", "turncue.js", "turncue.css", "window-label.js", "window-operations.js", "eta.js", "inactivity.js", "bulk-setup.js", "staff-import.js", "join-entry.js"].includes(file)) { response.writeHead(404).end(); return; }
  let content = fs.readFileSync(path.join(root, file), "utf8");
  if (file === "turncue.js") {
    content = content.replace("getFirestore, doc,", "getFirestore, connectFirestoreEmulator, doc,");
    content = content.replace("getFirestore(initializeApp(firebaseConfig));", 'getFirestore(initializeApp(firebaseConfig));\nconnectFirestoreEmulator(db, "127.0.0.1", 8787);');
    // Test-only gate forces two devices to select the same candidate.
    content = content.replace("const candidateRef = candidates.docs[0].ref;", "const candidateRef = candidates.docs[0].ref; await window.__candidateSelected?.(candidateRef.id);");
  }
  if (file === "index.html") {
    content = content.replace("getFirestore,", "getFirestore, connectFirestoreEmulator,");
    content = content.replace("const db = getFirestore(app);", 'const db = getFirestore(app);\nconnectFirestoreEmulator(db, "127.0.0.1", 8787);');
  }
  content = content.replaceAll("turncue-83e1a", project);
  response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
  response.end(content);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.TURNCUE_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe"
});
const errors = [];
const contexts = [];
async function pageAt(file, viewport = { width: 1100, height: 900 }) {
  const context = await browser.newContext({ viewport });
  contexts.push(context);
  // Both SDK modules are served from disk. ALL other external traffic is blocked.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if ([origin, emulator].includes(url.origin)) return route.continue();
    if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) {
      return route.fulfill({ path: path.join(assets, path.basename(url.pathname)), contentType: "text/javascript" });
    }
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", entry => { if (entry.type() === "error") console.log("BROWSER " + file + ": " + entry.text().slice(0, 1200)); });
  await page.goto(origin + "/" + file);
  return page;
}
async function operation(page, method, ...args) {
  return page.evaluate(async ({ method, args }) => {
    const app = await import("/turncue.js");
    return app[method](...args);
  }, { method, args });
}
async function documents(page, collectionPath) {
  return page.evaluate(async ({ sdk, collectionPath }) => {
    const app = await import("/turncue.js");
    const { getDocs, collection } = await import(sdk);
    const snapshot = await getDocs(collection(app.db, collectionPath));
    return snapshot.docs.map(s => ({ id: s.id, ...s.data() }));
  }, { sdk, collectionPath });
}
async function waitText(page, id, text) {
  await page.waitForFunction(({ id, text }) => document.getElementById(id)?.textContent.includes(text), { id, text }, { timeout: 20000 });
}
try {
  const manager = await pageAt('business.html');
  await waitText(manager,'sessionStatus','Queue session ready');
  await operation(manager,'saveWindow',null,'Window 1',true);
  await operation(manager,'saveWindow',null,'Window 5',true);
  await manager.locator('#addWindows').click();
  assert.equal(await manager.locator('#bulkCreate').isDisabled(),true);
  await manager.locator('#bulkMode').selectOption('numbered');
  await manager.locator('#bulkQuantity').fill('2');
  await waitText(manager,'bulkPreview','Window 6');
  assert((await manager.locator('#bulkPreview').textContent()).includes('Window 7'));
  await manager.locator('#cancelWindows').click();
  assert.equal((await documents(manager,'windows')).length,2);
  await manager.locator('#addWindows').click();
  assert.equal(await manager.locator('#bulkMode').inputValue(),'');
  assert.equal(await manager.locator('#bulkQuantity').inputValue(),'');
  await manager.locator('#bulkMode').selectOption('numbered');
  await manager.locator('#bulkQuantity').fill('2');
  await manager.locator('#bulkCreate').click();
  await waitText(manager,'message','Created: Window 6, Window 7.');
  const createdWindows=await documents(manager,'windows');
  assert.deepEqual(createdWindows.map(w=>w.name).sort(),['Window 1','Window 5','Window 6','Window 7']);
  for(const w of createdWindows.filter(w=>['Window 6','Window 7'].includes(w.name))) { assert.equal(w.currentStaffId,null); assert.equal(w.currentShiftId,null); }
  await manager.locator('#addWindows').click();
  await manager.locator('#bulkMode').selectOption('letters');
  await manager.locator('#bulkQuantity').fill('2');
  await waitText(manager,'bulkPreview','Window A');
  assert((await manager.locator('#bulkPreview').textContent()).includes('Window B'));
  await manager.locator('#cancelWindows').click();
  passed('Add Windows modal preview, reset, cancel, sequential create and independent letter series');
  const beforeImportShifts=await documents(manager,'shifts');
  await manager.locator('#staffCsv').setInputFiles({name:'release.csv',mimeType:'text/csv',buffer:Buffer.from('name,role\nRelease Staff,staff\nRelease Manager,manager\n')});
  await manager.locator('#staffImportForm button[type=submit]').click();
  await waitText(manager,'staffImportPreview','Release Staff');
  await manager.locator('#createStaffImport').click();
  await waitText(manager,'message','Saved.');
  const imported=(await documents(manager,'staff')).filter(p=>p.name.startsWith('Release '));
  assert.equal(imported.length,2);
  assert.notEqual(imported[0].staffCode,imported[1].staffCode);
  for(const p of imported) { assert.equal(p.currentShiftId,null); assert.equal(p.currentWindowId,null); }
  assert.equal((await documents(manager,'shifts')).length,beforeImportShifts.length);
  assert.deepEqual(await documents(manager,'windows'),createdWindows);
  assert.equal(await manager.locator('#createStaffImport').isDisabled(),true);
  passed('Staff CSV browser preview/create, unique Staff IDs, no assignments or shifts, repeat-submit blocked');

  assert.deepEqual(errors, [], 'uncaught browser errors');
  console.log('PASS Batch 3 browser checkpoint');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
