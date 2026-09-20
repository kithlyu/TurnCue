// ONLY the two ordered concurrency tests. No browser, UI, or production access.
// Existing Firebase 12.19.0 browser SDK is executed under Node with a fetch-backed
// XMLHttpRequest transport. SDK transactions/retries are not reimplemented.
// Run with Node --experimental-vm-modules; set TURNCUE_TEST_ASSETS to cached SDKs.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = process.env.TURNCUE_TEST_ASSETS;
const mode = process.argv[2];
assert(["join", "call"].includes(mode), "Use join or call.");
assert(assets, "TURNCUE_TEST_ASSETS is required.");
const projectId = "demo-turncue-focused";
const endpoint = "http://127.0.0.1:8787";
const base = endpoint + "/v1/projects/" + projectId + "/databases/(default)/documents";
const scope = { businessId: "demo-business", locationId: "main-location", queueId: "main-queue" };
const sessionId = mode + "-" + Date.now();
const rawFetch = globalThis.fetch;
let failNow;
const fatal = new Promise((_, reject) => { failNow = reject; });
fatal.catch(() => {});
const permissions = [];
globalThis.fetch = async (url, options) => {
  const target = new URL(typeof url === "string" || url instanceof URL ? url : url.url);
  assert.equal(target.origin, endpoint, "External network request blocked: " + target.origin);
  const response = await rawFetch(url, options);
  if (response.status === 403) {
    const message = "HTTP 403 " + target.pathname + ": " + await response.clone().text();
    permissions.push(message);
    if (mode === "join") failNow(new Error(message));
  }
  return response;
};
globalThis.self = globalThis;

// Only supplies HTTP transport to the unchanged downloaded Firebase SDK.
class FetchXMLHttpRequest {
  readyState = 0; status = 0; statusText = ""; responseText = ""; response = "";
  responseType = ""; withCredentials = false; timeout = 0;
  headers = {}; responseHeaders = new Headers(); controller = null;
  open(method, url) { this.method = method; this.url = url; this.readyState = 1; this.onreadystatechange?.(); }
  setRequestHeader(name, value) { this.headers[name] = value; }
  getResponseHeader(name) { return this.responseHeaders.get(name); }
  getAllResponseHeaders() { return [...this.responseHeaders].map(([k,v]) => k + ": " + v).join("\r\n"); }
  abort() { this.controller?.abort(); this.readyState = 0; }
  async send(body) {
    this.controller = new AbortController();
    try {
      const response = await fetch(this.url, { method: this.method, headers: this.headers, body, signal: this.controller.signal });
      this.status = response.status; this.statusText = response.statusText; this.responseHeaders = response.headers;
      this.readyState = 2; this.onreadystatechange?.();
      this.responseText = await response.text();
      this.response = this.responseType === "json" ? JSON.parse(this.responseText) : this.responseText;
      this.readyState = 4; this.onreadystatechange?.(); this.onload?.();
    } catch (error) {
      if (error.name === "AbortError") return;
      this.status = 0; this.readyState = 4; this.onreadystatechange?.(); this.onerror?.(error);
    }
  }
}
globalThis.XMLHttpRequest = FetchXMLHttpRequest;

const modules = new Map();
const sdkUrl = "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
const appUrl = "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
async function load(identifier) {
  if (modules.has(identifier)) return modules.get(identifier);
  const file = identifier === sdkUrl ? path.join(assets, "firebase-firestore.js")
    : identifier === appUrl ? path.join(assets, "firebase-app.js") : identifier;
  let source = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (identifier.endsWith("turncue.js")) {
    // Redirect initialization only, without changing operation implementations.
    source = source.replace('getFirestore, doc,', 'getFirestore, connectFirestoreEmulator, doc,');
    source = source.replace('getFirestore(initializeApp(firebaseConfig));',
      'getFirestore(initializeApp(firebaseConfig)); connectFirestoreEmulator(db, "127.0.0.1", 8787);');
    source = source.replaceAll("turncue-83e1a", projectId);
    source = source.replace("const candidateRef = candidates.docs[0].ref;",
      "const candidateRef = candidates.docs[0].ref; await globalThis.candidateGate(candidateRef.id, windowId);");
  }
  if (identifier.endsWith("join-entry.js")) {
    // Force every initial transaction to read the same counter before commits.
    source = source.replace("const nextTicketNumber = sessionData.nextTicketNumber;",
      "const nextTicketNumber = sessionData.nextTicketNumber; await globalThis.joinGate(entryId, nextTicketNumber);");
  }
  const module = new vm.SourceTextModule(source, { identifier });
  modules.set(identifier, module);
  await module.link(specifier => load(specifier));
  return module;
}
function gate(count) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const seen = new Set(), reads = [];
  return {
    reads,
    async enter(id, value) {
      if (seen.has(id)) return;
      seen.add(id); reads.push({ id, value });
      if (seen.size === count) release();
      await promise;
    }
  };
}
const joins = gate(6), calls = gate(2);
const candidateReads = [];
globalThis.joinGate = (entryId, ticket) => joins.enter(entryId, ticket);
globalThis.candidateGate = (entryId, windowId) => {
  candidateReads.push({ windowId, entryId });
  return calls.enter(windowId, entryId);
};
function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  throw new Error("Unsupported fixture type");
}
function decode(document) {
  return { id: document.name.split("/").at(-1), ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [
    key, "integerValue" in value ? Number(value.integerValue) :
      "nullValue" in value ? null : Object.values(value)[0]
  ])) };
}
async function seed(name, values) {
  const response = await fetch(base + "/" + name, {
    method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(values).map(([k,v]) => [k,encode(v)])) })
  });
  if (!response.ok) throw new Error("Fixture " + name + ": " + await response.text());
}
async function read(name) {
  const response = await fetch(base + "/" + name);
  if (!response.ok) throw new Error(await response.text());
  return decode(await response.json());
}
async function list(name) {
  const response = await fetch(base + "/" + name + "?pageSize=100");
  if (!response.ok) throw new Error(await response.text());
  return ((await response.json()).documents || []).map(decode);
}
const openSession = { ...scope, status: "open", ticketPrefix: "A", nextTicketNumber: 101, openedAt: new Date(), closedAt: null };

async function run() {
  const sdkModule = await load(sdkUrl);
  await sdkModule.evaluate();
  const sdk = sdkModule.namespace;
  const firebase = modules.get(appUrl).namespace;
  await seed("sessions/" + sessionId, openSession);
  if (mode === "join") {
    const joinModule = await load(path.join(root, "join-entry.js"));
    await joinModule.evaluate();
    const jobs = Array.from({ length: 6 }, (_, i) => {
      const app = firebase.initializeApp({ projectId, apiKey: "demo-only" }, "join-client-" + i);
      const db = sdk.initializeFirestore(app, { useFetchStreams: true });
      sdk.connectFirestoreEmulator(db, "127.0.0.1", 8787);
      return joinModule.namespace.joinEntry(db, { ...scope, sessionId, entryId: "join-" + i })
        .then(ticket => ({ entryId: "join-" + i, ticket }));
    });
    const results = await Promise.all(jobs);
    const entries = await list("sessions/" + sessionId + "/entries");
    assert.equal(permissions.length, 0, "No permission-denied errors allowed, including recovered attempts.");
    assert.equal(joins.reads.length, 6);
    assert(joins.reads.every(r => r.value === 101), "All initial reads must compete for A101");
    assert.equal(entries.length, results.length);
    assert(entries.every(entry => entry.status === "waiting"));
    assert.deepEqual(entries.map(e => e.ticketNumber).sort((a,b) => a-b), [101,102,103,104,105,106]);
    for (const result of results) assert.equal(entries.filter(e => e.id === result.entryId && e.ticketLabel === result.ticket).length, 1);
    assert.equal((await read("sessions/" + sessionId)).nextTicketNumber, 107);
    console.log("concurrent JOIN: PASS — 6 synchronized joins; A101–A106; exactly 6 waiting entries; 0 permission errors.");
    return;
  }
  // CALL NEXT setup is independent of JOIN, and has exactly two waiting entries.
  await seed("queues/main-queue", { businessId: scope.businessId, locationId: scope.locationId, currentSessionId: sessionId });
  for (let i = 1; i <= 2; i++) {
    await seed("sessions/" + sessionId + "/entries/customer-" + i, {
      ...scope, sessionId, ticketNumber: 100+i, ticketLabel: "A" + (100+i), status: "waiting",
      joinedAt: new Date(Date.now() - 10000 + i), calledAt: null, completedAt: null, cancelledAt: null
    });
    await seed("staff/staff-" + i, {
      businessId: scope.businessId, name: "Staff " + i, staffCode: "TC-STAFF00" + i, role: "staff", active: true,
      currentShiftId: "shift-" + i, currentWindowId: "window-" + i, createdAt: new Date(), updatedAt: new Date()
    });
    await seed("windows/window-" + i, {
      ...scope, name: "Window " + i, active: true, state: "active", currentStaffId: "staff-" + i,
      currentShiftId: "shift-" + i, currentEntryId: null, currentSessionId: null, currentTicketLabel: null,
      lastEventId: null, lastActionAt: new Date(), stateChangedAt: new Date(), createdAt: new Date(), updatedAt: new Date()
    });
    await seed("shifts/shift-" + i, {
      ...scope, staffId: "staff-" + i, windowId: "window-" + i, state: "active",
      startedAt: new Date(), endedAt: null, currentEntryId: null, currentSessionId: null, lastActionAt: new Date()
    });
  }
  const appModule = await load(path.join(root, "turncue.js"));
  await appModule.evaluate();
  const results = await Promise.all([1,2].map(i => appModule.namespace.callNext("window-" + i, "shift-" + i, sessionId)));
  const entries = await list("sessions/" + sessionId + "/entries");
  assert.deepEqual(results.slice().sort(), ["A101", "A102"]);
  assert.equal(calls.reads[0].value, calls.reads[1].value, "Both first candidates must be the same entry");
  assert(candidateReads.length >= 3, "Losing caller must query another waiting candidate");
  assert.equal(entries.length, 2);
  assert(entries.every(e => e.status === "called"));
  assert.equal(new Set(entries.map(e => e.calledWindowId)).size, 2);
  for (let i = 1; i <= 2; i++) {
    const entry = entries.find(e => e.calledWindowId === "window-" + i);
    assert(entry);
    assert.equal(entry.calledWindowLabel, "Window " + i);
    assert.equal(entry.calledByStaffId, "staff-" + i);
    assert.equal(entry.calledByShiftId, "shift-" + i);
    assert.equal((await read("windows/window-" + i)).currentEntryId, entry.id);
    assert.equal((await read("shifts/shift-" + i)).currentEntryId, entry.id);
  }
  console.log("concurrent CALL NEXT: PASS — same first candidate forced; losing caller retried; A101/A102 assigned once; all 4 destination/ownership fields correct.");
}
const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Focused " + mode + " test exceeded 60 seconds")), 60000));
try {
  await Promise.race([run(), fatal, timeout]);
  process.exit(0);
} catch (error) {
  console.error("concurrent " + mode.toUpperCase() + ": FAIL");
  console.error(error.code || error.name, error.message);
  if (permissions.length) console.error("Permission errors:", JSON.stringify(permissions));
  process.exit(1);
}

