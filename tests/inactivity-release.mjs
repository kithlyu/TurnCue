// Maintained Batch 3 serial and concurrent inactivity checkpoint; loopback only.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = process.env.TURNCUE_TEST_ASSETS;
assert(assets, "TURNCUE_TEST_ASSETS is required.");
const endpoint = "http://127.0.0.1:8787", project = "demo-turncue-inactivity-" + Date.now();
const base = endpoint + "/v1/projects/" + project + "/databases/(default)/documents";
const scope = { businessId: "demo-business", locationId: "main-location", queueId: "main-queue" };

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


const originalRules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
const response = await fetch(endpoint + '/emulator/v1/projects/' + project + ':securityRules', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({rules:{files:[{name:'firestore.rules',content:originalRules}]}})});
const compilation = await response.json(); assert(response.ok); assert(!compilation.issues?.some(x=>x.severity==='ERROR'), JSON.stringify(compilation));
console.log('PASS current rules compile; project '+project);
const module = await load(path.join(root,'turncue.js')); await module.evaluate();
const app = module.namespace, sdk = (await load(sdkUrl)).namespace;
const learned = {confidence:'early',paceMinutes:8};
const read = async name => (await sdk.getDocFromServer(sdk.doc(app.db,name))).data();
const events = async (id,type) => (await list('windowEvents')).filter(e=>e.windowId===id&&e.type===type);
async function fixture(id,waiting=true) {
  await seed('sessions/'+id, {...scope,status:'open',ticketPrefix:'A',nextTicketNumber:102,openedAt:new Date(),closedAt:null});
  if(waiting) await seed('sessions/'+id+'/entries/waiting',{...scope,sessionId:id,ticketNumber:101,ticketLabel:'A101',status:'waiting',joinedAt:new Date(),calledAt:null,completedAt:null,cancelledAt:null});
  await seed('windows/'+id,{...scope,name:id,active:true,state:'active',currentStaffId:id,currentShiftId:id,currentEntryId:null,currentSessionId:null,currentTicketLabel:null,lastEventId:null,lastActionAt:new Date(Date.now()-17*60000),stateChangedAt:new Date(),createdAt:new Date(),updatedAt:new Date()});
  await seed('staff/'+id,{businessId:scope.businessId,name:id,staffCode:'TC-STAFF001',role:'staff',active:true,currentShiftId:id,currentWindowId:id,createdAt:new Date(),updatedAt:new Date()});
  await seed('shifts/'+id,{...scope,staffId:id,windowId:id,state:'active',startedAt:new Date(),endedAt:null,currentEntryId:null,currentSessionId:null,lastActionAt:new Date()});
}
function cleared(w) { for(const key of ['inactivityCheckState','inactivityCheckId','inactivityCheckStartedAt','inactivityCheckDeadline']) assert.equal(w[key],null,key); }
let currentCase='1 uncontended start';
try {
  await fixture('serial-start');
  const beforeConfirmation=await read('windows/serial-start');
  const check=await app.startInactivityCheck('serial-start','serial-start','serial-start',learned);
  assert(check); let w=await read('windows/serial-start'); assert.equal(w.inactivityCheckState,'pending'); assert.equal(w.inactivityCheckId,check); assert.equal((await events('serial-start','inactivity_check_started')).length,1);
  console.log('PASS 1 uncontended start: pending, exactly one start event');
  currentCase='2 confirmation';
  await app.confirmInactivityCheck('serial-start','serial-start',check);
  w=await read('windows/serial-start'); cleared(w); assert(w.lastActionAt.toMillis()>beforeConfirmation.lastActionAt.toMillis()); assert.equal(w.state,'active'); assert.equal(w.currentShiftId,'serial-start'); assert.equal((await events('serial-start','inactivity_check_confirmed')).length,1);
  console.log('PASS 2 confirmation: cleared, active, exactly one confirmation event');
  currentCase='3 empty-queue cancellation';
  await fixture('serial-cancel');
  const cancelCheck=await app.startInactivityCheck('serial-cancel','serial-cancel','serial-cancel',learned); assert(cancelCheck);
  await sdk.updateDoc(sdk.doc(app.db,'sessions/serial-cancel/entries/waiting'),{status:'cancelled',cancelledAt:sdk.serverTimestamp()});
  assert.equal(await app.cancelInactivityCheckIfQueueEmpty('serial-cancel','serial-cancel','serial-cancel',cancelCheck),'cancelled');
  w=await read('windows/serial-cancel'); cleared(w); assert.equal(w.state,'active'); assert.equal(w.pauseSource??null,null); assert.equal(w.reviewFlagType??null,null); assert.equal((await events('serial-cancel','inactivity_check_cancelled')).length,1); assert.equal((await events('serial-cancel','window_auto_paused')).length,0);
  console.log('PASS 3 cancellation: cleared, active, no review/auto-pause, exactly one cancellation event');
  currentCase='4 expiry/auto-pause';
  await fixture('serial-expiry');
  const expiryCheck=await app.startInactivityCheck('serial-expiry','serial-expiry','serial-expiry',learned); assert(expiryCheck);
  w=await read('windows/serial-expiry'); const deadline=w.inactivityCheckDeadline.toMillis();
  while(Date.now()<deadline+300) { console.log('WAIT real expiry: '+Math.ceil((deadline-Date.now())/1000)+' seconds remaining'); await new Promise(r=>setTimeout(r,Math.min(30000,deadline+300-Date.now()))); }
  assert.equal(await app.resolveExpiredInactivityCheck('serial-expiry','serial-expiry','serial-expiry',expiryCheck),'auto_paused');
  w=await read('windows/serial-expiry'); cleared(w); assert.equal(w.state,'paused'); assert.equal(w.currentShiftId,'serial-expiry'); assert.equal(w.currentStaffId,'serial-expiry'); assert.equal(w.reviewFlagType,'inactivity_check'); assert(w.reviewFlagAt); assert.equal(w.pauseSource,'inactivity_check'); const shift=await read('shifts/serial-expiry'); assert.equal(shift.state,'paused'); assert.equal(shift.endedAt,null); assert.equal((await events('serial-expiry','window_auto_paused')).length,1);
  console.log('PASS 4 real expiry: one auto-pause, retained assignment, review flag');
  currentCase='5 concurrent start';
  await fixture('concurrent-start');
  const results=await Promise.allSettled([app.startInactivityCheck('concurrent-start','concurrent-start','concurrent-start',learned),app.startInactivityCheck('concurrent-start','concurrent-start','concurrent-start',learned)]);
  assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value).length,1);
  w=await read('windows/concurrent-start'); assert.equal(w.inactivityCheckState,'pending'); const startEvents=await events('concurrent-start','inactivity_check_started'); assert.equal(startEvents.length,1); assert.equal(startEvents[0].checkId,w.inactivityCheckId); assert.equal(results.find(r=>r.status==='fulfilled'&&r.value).value,w.inactivityCheckId);
  for(const r of results) if(r.status==='rejected') { assert(['permission-denied','firestore/permission-denied'].includes(r.reason.code)); console.log('EXPECTED contention loser: '+r.reason.code+' '+r.reason.message); }
  console.log('PASS 5 one winning start and event; loser outcomes '+JSON.stringify(results.map(r=>r.status==='fulfilled'?{status:r.status,value:r.value}:{status:r.status,code:r.reason.code})));
} catch(e) { console.error('FAIL CASE '+currentCase); console.error(e); process.exitCode=1; }
finally { assert.equal(fs.readFileSync(path.join(root,'firestore.rules'),'utf8'),originalRules,'Rules unchanged'); await sdk.terminate(app.db); }
