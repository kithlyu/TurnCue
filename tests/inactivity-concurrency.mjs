// Focused local-only race test for one pending inactivity check.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = process.env.TURNCUE_TEST_ASSETS;
assert(assets, "TURNCUE_TEST_ASSETS is required.");
const endpoint = "http://127.0.0.1:8787", project = "demo-turncue-inactivity";
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
function encode(value) {
  if (value === null) return { nullValue: null }; if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value }; if (typeof value === "number") return { integerValue: String(value) };
  if (value instanceof Date) return { timestampValue: value.toISOString() }; throw new Error("unsupported fixture");
}
async function seed(name, values) {
  const response = await fetch(base + "/" + name, { method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encode(value)])) }) });
  assert(response.ok, await response.text());
}
function decode(document) { return { id: document.name.split("/").at(-1), ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, "integerValue" in value ? Number(value.integerValue) : "nullValue" in value ? null : Object.values(value)[0]])) }; }
async function list(name) {
  const response = await fetch(base + "/" + name + "?pageSize=100");
  const text = await response.text();
  assert(response.ok, text);
  return (JSON.parse(text).documents || []).map(decode);
}

await seed("sessions/" + sessionId, { ...scope, status: "open", ticketPrefix: "A", nextTicketNumber: 102, openedAt: new Date(), closedAt: null });
if (mode === "start") await seed("sessions/" + sessionId + "/entries/waiting", { ...scope, sessionId, ticketNumber: 101, ticketLabel: "A101", status: "waiting", joinedAt: new Date(), calledAt: null, completedAt: null, cancelledAt: null });
const checkId = "known-pending-check";
await seed("windows/window-1", { ...scope, name: "Window 1", active: true, state: "active", currentStaffId: "staff-1", currentShiftId: "shift-1", currentEntryId: null, currentSessionId: null, currentTicketLabel: null, lastEventId: null, lastActionAt: new Date(Date.now() - 16 * 60000), stateChangedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), inactivityCheckState: mode === "cancel" ? "pending" : null, inactivityCheckId: mode === "cancel" ? checkId : null, inactivityCheckStartedAt: mode === "cancel" ? new Date() : null, inactivityCheckDeadline: mode === "cancel" ? new Date(Date.now() + 120000) : null, pauseSource: null, reviewFlagType: null, reviewFlagAt: null });
await seed("staff/staff-1", { businessId: scope.businessId, name: "Staff", staffCode: "TC-STAFF001", role: "staff", active: true, currentShiftId: "shift-1", currentWindowId: "window-1", createdAt: new Date(), updatedAt: new Date() });
await seed("shifts/shift-1", { ...scope, staffId: "staff-1", windowId: "window-1", state: "active", startedAt: new Date(), endedAt: null, currentEntryId: null, currentSessionId: null, lastActionAt: new Date() });
const module = await load(path.join(root, "turncue.js")); await module.evaluate();
const learned = { confidence: "early", paceMinutes: 8 };
const results = mode === "start"
  ? await Promise.all([module.namespace.startInactivityCheck("window-1", "shift-1", sessionId, learned), module.namespace.startInactivityCheck("window-1", "shift-1", sessionId, learned)])
  : await Promise.all([module.namespace.cancelInactivityCheckIfQueueEmpty("window-1", "shift-1", sessionId, checkId), module.namespace.cancelInactivityCheckIfQueueEmpty("window-1", "shift-1", sessionId, checkId)]);
const [window] = await list("windows");
const events = (await list("windowEvents")).filter(event => event.type === (mode === "start" ? "inactivity_check_started" : "inactivity_check_cancelled"));
assert.equal(window.state, "active");
if (mode === "start") { assert.equal(window.inactivityCheckState, "pending"); assert.equal(typeof window.inactivityCheckId, "string"); assert.equal(events.length, 1); assert.equal(events[0].checkId, window.inactivityCheckId); }
else { assert.equal(window.inactivityCheckState, null); assert.equal(window.inactivityCheckId, null); assert.notEqual(window.pauseSource, "inactivity_check"); assert.equal(window.reviewFlagType, null); assert.equal(events.length, 1); assert.equal(events[0].reason, "queue_empty"); }
assert.equal(results.filter(Boolean).length, 1);
console.log("inactivity " + mode + " concurrency: PASS — one final transition event.");
