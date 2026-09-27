// Focused immutable-window-label integration test. Local emulator and cached SDK only.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = process.env.TURNCUE_TEST_ASSETS;
assert(assets, "TURNCUE_TEST_ASSETS is required.");
const endpoint = "http://127.0.0.1:8787", project = "demo-turncue-retired-" + Date.now();
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

const id = await app.saveWindow(null, "Retired-looking normal label", true);
const code = await app.registerStaff("Test Staff", "staff"), person = await app.findStaff(code);
const shiftId = await app.startShift(person.id, id);
await app.changeWindowState(id, shiftId, "pause");
await app.changeWindowState(id, shiftId, "resume");
await app.changeWindowState(id, shiftId, "end");
console.log("PASS missing retired field and name text do not block normal shifts");
async function tag(id) {
 const r = await fetch(base + "/windows/" + id + "?updateMask.fieldPaths=retired", {method:"PATCH",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:JSON.stringify({fields:{retired:{booleanValue:true}}})});
 assert(r.ok, await r.text());
}
await tag(id);
await assert.rejects(app.saveWindow(id, "Retired-looking normal label", true), /retired/);
await assert.rejects(app.saveWindow(id, "Retired-looking normal label", false), /retired/);
await assert.rejects(app.startShift(person.id, id), /no longer available/);
const assigned = await app.saveWindow(null, "Assigned", true);
const assignedShift = await app.startShift(person.id, assigned);
await app.changeWindowState(assigned, assignedShift, "pause");
await tag(assigned);
await assert.rejects(app.changeWindowState(assigned, assignedShift, "resume"), /assignment has changed/);
assert.equal((await sdk.getDocFromServer(sdk.doc(app.db,"windows",assigned))).data().state,"paused");
console.log("PASS direct normal-client activation, assignment and resume blocked for retired windows");
const etaModule=await import("../eta.js"), inactivity=await import("../inactivity.js");
const retired={retired:true,active:true,state:"active",currentShiftId:"shift",currentStaffId:"staff",currentEntryId:null};
assert.equal(etaModule.estimateWait({windows:[retired],samples:[],waitingEntries:[],entryId:"x"}).mode,"no_capacity");
assert.equal(inactivity.isInactivityEligible(retired,true,{confidence:"early",paceMinutes:8}),false);
console.log("PASS retired capacity and inactivity exclusion");
await sdk.terminate(app.db);process.exit(0);
