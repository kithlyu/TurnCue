// Focused canonical window creation integration test. Local emulator and cached SDK only.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = process.env.TURNCUE_TEST_ASSETS;
assert(assets, "TURNCUE_TEST_ASSETS is required.");
const endpoint = "http://127.0.0.1:8787", project = "demo-turncue-unique-" + Date.now();
const mode = process.argv[2] || "start";
assert(["start", "cancel"].includes(mode));
const base = endpoint + "/v1/projects/" + project + "/databases/(default)/documents";
const scope = { businessId: "demo-business", locationId: "main-location", queueId: "main-queue" };
const sessionId = "inactivity-race";
const rawFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const target = new URL(typeof url === "string" ? url : url.url);
  assert.equal(target.origin, endpoint, "External network request blocked: " + target.origin);
  return rawFetch(url, options);
};
globalThis.self = globalThis;
class FetchXMLHttpRequest {
  readyState = 0; status = 0; responseText = ""; response = ""; headers = {}; responseHeaders = new Headers();
  open(method, url) { this.method = method; this.url = url; this.readyState = 1; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  getResponseHeader(name) { return this.responseHeaders.get(name); }
  getAllResponseHeaders() { return ""; }
  async send(body) { try { const response = await fetch(this.url, { method: this.method, headers: this.headers, body }); this.status = response.status; this.responseHeaders = response.headers; this.responseText = await response.text(); this.response = this.responseText; this.readyState = 4; this.onreadystatechange?.(); this.onload?.(); } catch (error) { this.status = 0; this.readyState = 4; this.onerror?.(error); } }
}
globalThis.XMLHttpRequest = FetchXMLHttpRequest;
const sdkUrl = "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
const appUrl = "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
const modules = new Map();
async function load(identifier) {
  if (modules.has(identifier)) return modules.get(identifier);
  const file = identifier === sdkUrl ? path.join(assets, "firebase-firestore.js") : identifier === appUrl ? path.join(assets, "firebase-app.js") : identifier;
  let source = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (identifier.endsWith("environment.js")) source = source.replaceAll("demo-turncue-local", project);
  if (identifier.endsWith("firebase-client.js")) source = source.replace("resolveEnvironment(globalThis.location)", 'resolveEnvironment({ hostname: "localhost" })');

  const module = new vm.SourceTextModule(source, { identifier }); modules.set(identifier, module);
  await module.link(specifier => load(specifier.startsWith(".") ? path.resolve(path.dirname(identifier), specifier) : specifier));
  return module;
}

const rulesResponse = await fetch(endpoint + "/emulator/v1/projects/" + project + ":securityRules", {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content: fs.readFileSync(path.join(root, "firestore.rules"), "utf8") }] } })
});
const ruleText = await rulesResponse.text();
assert(rulesResponse.ok, ruleText);
assert(!JSON.parse(ruleText).issues?.some(issue => issue.severity === "ERROR"), ruleText);
console.log("PASS rules compile");
const appModule = await load(path.join(root, "turncue.js")); await appModule.evaluate();
const app = appModule.namespace, sdk = modules.get(sdkUrl).namespace;

const stamp = sdk.serverTimestamp;
const originals = [["original-one", "1"], ["original-two", "2"], ["original-letter", "A"]];
for (const [id, name] of originals) await sdk.setDoc(sdk.doc(app.db, "windows", id), {
  ...scope, name, active: true, state: "available", currentStaffId: null, currentShiftId: null,
  currentEntryId: null, currentSessionId: null, currentTicketLabel: null, lastEventId: null,
  lastActionAt: null, stateChangedAt: stamp(), createdAt: stamp(), updatedAt: stamp()
});
// Legacy fixtures intentionally have no reservations.
const labels = ["Window 1", "Window 2", "Window A", " window a "];
const bulk = await app.bulkCreateWindows(labels);
assert(bulk.every(result => !result.ok && /Already exists/.test(result.error)));
for (const name of labels) await assert.rejects(app.saveWindow(null, name, true), /Already exists/);
console.log("PASS direct bulk and individual creation reject legacy equivalents without reservations");
const three = await app.bulkCreateWindows(["Window 3"]); assert.equal(three[0].ok, true);
await assert.rejects(app.saveWindow(null, " 3 ", true), /Already exists/);
assert.equal((await app.bulkCreateWindows(["window 3"]))[0].ok, false);
for (const [id, name] of originals) assert.equal((await sdk.getDocFromServer(sdk.doc(app.db, "windows", id))).data().name, name);
const records = await sdk.getDocsFromServer(sdk.collection(app.db, "windows"));
assert.equal(records.size, 4);
const third = records.docs.find(d => d.data().name === "Window 3"); assert(third);
assert.equal((await sdk.getDocFromServer(sdk.doc(app.db, "windowLabels", "window 3"))).data().windowId, third.id);
console.log("PASS original legacy IDs/names unchanged; Window 3 created and reserved exactly once");
// Both creation entry points contend for the same canonical reservation.
const results = await Promise.allSettled([app.saveWindow(null, "B", true), app.bulkCreateWindows([" Window b "])]);
const individualWon = results[0].status === "fulfilled";
assert.equal(results[1].status, "fulfilled");
assert.equal(Number(individualWon) + Number(results[1].value[0].ok), 1);
const all = await sdk.getDocsFromServer(sdk.collection(app.db, "windows"));
assert.equal(all.size, 5);
const reservation = (await sdk.getDocFromServer(sdk.doc(app.db, "windowLabels", "window b"))).data();
assert(all.docs.some(d => d.id === reservation.windowId));
console.log("PASS concurrent individual/bulk canonical creation has one winner");
await sdk.terminate(app.db); process.exit(0);
