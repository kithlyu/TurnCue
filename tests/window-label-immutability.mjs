// Focused immutable-window-label integration test. Local emulator and cached SDK only.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = process.env.TURNCUE_TEST_ASSETS;
assert(assets, "TURNCUE_TEST_ASSETS is required.");
const endpoint = "http://127.0.0.1:8787", project = "demo-turncue-labels-" + Date.now();
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
  if (identifier.endsWith("turncue.js")) {
    source = source.replace("getFirestore, doc,", "getFirestore, connectFirestoreEmulator, doc,");
    source = source.replace("getFirestore(initializeApp(firebaseConfig));", 'getFirestore(initializeApp(firebaseConfig)); connectFirestoreEmulator(db, "127.0.0.1", 8787);');
    source = source.replaceAll("turncue-83e1a", project);
  }
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
const id = await app.saveWindow(null, "1", true);
const windowRef = sdk.doc(app.db, "windows", id);
const read = async () => (await sdk.getDocFromServer(windowRef)).data();
assert.equal((await read()).name, "1");
console.log("PASS creation preserves supplied label");
await assert.rejects(app.saveWindow(id, "Window 1", true), /permanent/);
await assert.rejects(sdk.updateDoc(windowRef, { name: "Renamed", updatedAt: sdk.serverTimestamp() }), error => error.code === "permission-denied");
console.log("PASS unassigned rename blocked by application and rules");
await app.saveWindow(id, "1", false);
assert.equal((await read()).state, "inactive");
await assert.rejects(app.saveWindow(id, "Changed", false), /permanent/);
await assert.rejects(sdk.updateDoc(windowRef, { name: "Changed", active: true, state: "available", lastEventId: "bypass", stateChangedAt: sdk.serverTimestamp(), updatedAt: sdk.serverTimestamp() }), error => error.code === "permission-denied");
await app.saveWindow(id, "1", true);
assert.equal((await read()).state, "available"); assert.equal((await read()).name, "1");
console.log("PASS disabled rename and rename-through-enable denied; unchanged enable/disable allowed");
const code = await app.registerStaff("Test Staff", "staff");
const person = await app.findStaff(code);
const shiftId = await app.startShift(person.id, id);
await assert.rejects(app.saveWindow(id, "Changed", false), /End the shift/);
await assert.rejects(app.saveWindow(id, "1", false), /End the shift/);
await assert.rejects(sdk.updateDoc(windowRef, { active: false, state: "inactive", lastEventId: "bypass", stateChangedAt: sdk.serverTimestamp(), updatedAt: sdk.serverTimestamp() }), error => error.code === "permission-denied");
await assert.rejects(sdk.updateDoc(windowRef, { name: "Changed", updatedAt: sdk.serverTimestamp() }), error => error.code === "permission-denied");
assert.equal((await read()).currentShiftId, shiftId); assert.equal((await read()).name, "1");
console.log("PASS assigned-window protections preserved");
assert(!fs.readFileSync(path.join(root, "business.html"), "utf8").includes('actionButton("RENAME"'));
console.log("PASS manager rename action removed");
await sdk.terminate(app.db);
process.exit(0);
