// Focused immutable-window-label integration test. Local emulator and cached SDK only.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = process.env.TURNCUE_TEST_ASSETS;
assert(assets, "TURNCUE_TEST_ASSETS is required.");
const endpoint = "http://127.0.0.1:8787", project = "demo-turncue-operations-" + Date.now();
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


const { windowStatus, canConfigureWindow } = await import('../window-operations.js');
const { estimateWait } = await import('../eta.js');
const id = await app.saveWindow(null, 'Window 1', true);
const read = async () => (await sdk.getDocFromServer(sdk.doc(app.db, 'windows', id))).data();
const code = await app.registerStaff('Operations Staff', 'staff'), person = await app.findStaff(code);
assert.equal(windowStatus(await read()), 'OPEN');
assert.equal(canConfigureWindow(await read()), true);
await app.saveWindow(id, 'Window 1', false);
const closed = await read();
assert.equal(windowStatus(closed), 'CLOSED');
assert.equal(closed.state, 'inactive');
assert.equal(estimateWait({windows:[closed],samples:[],waitingEntries:[],entryId:'x'}).mode, 'no_capacity');
await assert.rejects(app.startShift(person.id, id), /no longer available/);
await app.saveWindow(id, 'Window 1', true);
assert.equal(windowStatus(await read()), 'OPEN');
const shift = await app.startShift(person.id, id);
assert.equal(windowStatus(await read()), 'OPEN');
await assert.rejects(app.saveWindow(id, 'Window 1', false), /End the shift/);
await app.changeWindowState(id, shift, 'pause');
assert.equal(windowStatus(await read()), 'PAUSED');
assert.equal((await read()).currentShiftId, shift);
assert.equal((await read()).currentStaffId, person.id);
await assert.rejects(app.saveWindow(id, 'Window 1', false), /End the shift/);
await app.changeWindowState(id, shift, 'resume');
assert.equal(windowStatus(await read()), 'OPEN');
await app.changeWindowState(id, shift, 'end');
// Seed inconsistent legacy pointers through emulator admin only: never silently clear them.
for (const fields of [
  {currentEntryId:{stringValue:'called'},currentSessionId:{stringValue:'session'}},
  {currentStaffId:{stringValue:'staff'}},
  {state:{stringValue:'active'}}
]) {
  const url = base + '/windows/' + id + '?' + Object.keys(fields).map(key=>'updateMask.fieldPaths='+key).join('&');
  const result = await fetch(url, {method:'PATCH',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body:JSON.stringify({fields})});
  assert(result.ok, await result.text());
  const before = await read();
  assert.equal(canConfigureWindow(before), false);
  await assert.rejects(app.saveWindow(id, 'Window 1', false), /assigned customer|End the shift/);
  assert.deepEqual(await read(), before);
  const cleared = Object.fromEntries(Object.keys(fields).map(key=>[key,key === 'state' ? {stringValue:'available'} : {nullValue:null}]));
  const reset = await fetch(url, {method:'PATCH',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body:JSON.stringify({fields:cleared})});
  assert(reset.ok, await reset.text());
}
assert.equal(windowStatus({...closed,retired:true}), null);
assert.equal(canConfigureWindow({...closed,retired:true}), false);
const manager = fs.readFileSync(path.join(root,'business.html'),'utf8');
assert(manager.includes('windowStatus(window)'));
assert(manager.includes('canConfigureWindow(window)'));
assert(manager.includes('"CLOSE WINDOW" : "OPEN WINDOW"'));
assert(!manager.includes('DISABLE WINDOW'));
const staff = fs.readFileSync(path.join(root,'staff.html'),'utf8');
assert(staff.includes('w.retired !== true && w.active && w.state === "available" && !w.currentShiftId'));
console.log('PASS OPEN/PAUSED/CLOSED transitions, assignment retention, close guards, closed shift/capacity exclusion and UI wiring');
await sdk.terminate(app.db); process.exit(0);
