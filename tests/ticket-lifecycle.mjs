// Focused ticket lifecycle integration and rules checks; isolated local emulator.
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


const joinModule = await load(path.join(root, 'join-entry.js')); await joinModule.evaluate();
const join = joinModule.namespace.joinEntry;
const readDoc = async (...parts) => (await sdk.getDocFromServer(sdk.doc(app.db, ...parts))).data();
const entry = id => readDoc('sessions', sid, 'entries', id);
const entryDoc = id => sdk.doc(app.db, 'sessions', sid, 'entries', id);
const act = async (id, action, attempt = undefined) => action === 'need_more_time'
  ? app.confirmNeedMoreTime(sid,id,(await app.requestNeedMoreTime(sid,id)).proposalId)
  : app.transitionTicket(sid, id, action, wid, shift, 'staff', attempt === undefined ? (await entry(id)).callAttemptId ?? null : attempt);
const complete = async id => app.completeCustomer(sid,id,wid,shift,'staff',(await entry(id)).callAttemptId ?? null);
const denied = operation => assert.rejects(operation, error => ['permission-denied', 'firestore/permission-denied'].includes(error.code));
let sid, wid, shift;
async function newTicket(id) { await join(app.db, {...scope, sessionId:sid, entryId:id}); return entry(id); }
async function call(id) { await newTicket(id); await app.callNext(wid, shift, sid); assert.equal((await entry(id)).status, 'called'); }
async function emptyPointers() {
  for (const [collection, id] of [['windows',wid],['shifts',shift]]) {
    const d = await readDoc(collection,id); assert.equal(d.currentEntryId,null); assert.equal(d.currentSessionId,null);
  }
  const w=await readDoc('windows',wid); assert.equal(w.currentTicketLabel,null); assert.equal(w.currentEntryCalledAt,null);
}
async function events(id) { return (await sdk.getDocsFromServer(sdk.collection(entryDoc(id),'events'))).docs; }
try {
  sid=await app.initializeTurnCue();
  wid=await app.saveWindow(null,'Lifecycle Window',true);
  const code=await app.registerStaff('Lifecycle Staff','staff'), person=await app.findStaff(code);
  shift=await app.startShift(person.id,wid);
  // Need More Time now requires existing learned pace; keep lifecycle tests focused.
  for (let i=0;i<3;i++) await sdk.setDoc(sdk.doc(app.db,'queues',scope.queueId,'serviceSamples','pace-'+i), {
    ...scope, sessionId:sid, entryId:'pace-'+i, windowId:wid, shiftId:shift,
    calledAt:sdk.Timestamp.fromMillis(Date.now()-8*60000), completedAt:sdk.serverTimestamp(),
    durationSeconds:null, durationMinutes:null, cleanEligible:true, exclusionReason:null, recordedAt:sdk.serverTimestamp()
  });

  await call('normal'); const called=await entry('normal');
  await act('normal','confirm_present'); const present=await entry('normal');
  assert.equal(present.status,'in_progress'); assert.equal(present.calledAt.toMillis(),called.calledAt.toMillis()); assert(present.confirmedPresentAt);
  assert.equal((await readDoc('windows',wid)).currentEntryId,'normal');
  assert.equal((await readDoc('shifts',shift)).currentEntryId,'normal');
  await assert.rejects(act('normal','confirm_present'));
  await assert.rejects(act('normal','no_show'));
  await assert.rejects(app.changeWindowState(wid,shift,'end'));
  await app.changeWindowState(wid,shift,'pause');
  await complete('normal');
  await emptyPointers(); assert.equal((await entry('normal')).status,'completed');
  const sample=await readDoc('queues',scope.queueId,'serviceSamples','normal');
  assert.equal(sample.calledAt.toMillis(),called.calledAt.toMillis()); assert.equal(sample.cleanEligible,false);
  await app.changeWindowState(wid,shift,'resume');
  console.log('PASS call, presence, unchanged calledAt, paused completion, history and shift guard');

  for(const [id,action,confirm] of [['absent','no_show',false],['opt-call','opted_out',false],['opt-service','opted_out',true]]) {
    await call(id); if(confirm) await act(id,'confirm_present');
    await act(id,action); assert.equal((await entry(id)).status,action); await emptyPointers();
    await assert.rejects(act(id,action)); await assert.rejects(complete(id));
    assert.equal((await events(id)).length,confirm?2:1);
  }
  console.log('PASS no-show and opted-out terminal outcomes, duplicates rejected, atomic cleanup');

  await newTicket('time'); const joined=(await entry('time')).joinedAt.toMillis();
  await act('time','need_more_time'); assert.equal((await entry('time')).status,'waiting');
  assert((await entry('time')).customerNeedMoreTimeAt);
  await assert.rejects(act('time','need_more_time'));
  await app.callNext(wid,shift,sid); const firstCall=(await entry('time')).calledAt.toMillis();
  await assert.rejects(act('time','need_more_time'));
  await act('time','confirm_present'); await act('time','staff_need_more_time'); await emptyPointers();
  let t=await entry('time'); assert.equal(t.status,'waiting'); assert(t.customerNeedMoreTimeAt && t.staffNeedMoreTimeAt); assert.equal(t.joinedAt.toMillis(),joined);
  const prior=(await events('time')).find(d=>d.data().type==='staff_need_more_time');
  assert.equal(prior.data().calledAt.toMillis(),firstCall); assert.equal(prior.data().windowId,wid);
  await app.callNext(wid,shift,sid); assert.equal((await entry('time')).confirmedPresentAt,null);
  await assert.rejects(act('time','staff_need_more_time'));
  await act('time','service_interrupted'); await emptyPointers(); assert.equal((await entry('time')).status,'waiting');
  await app.callNext(wid,shift,sid); await act('time','confirm_present'); await act('time','service_interrupted'); await emptyPointers();
  await act('time','left_queue'); assert.equal((await entry('time')).status,'left_queue');
  await assert.rejects(act('time','left_queue'));
  await denied(sdk.updateDoc(prior.ref,{type:'no_show'}));
  await denied(sdk.deleteDoc(prior.ref));
  console.log('PASS separate one-use allowances, preserved history, interruptions and left-queue');

  await call('staff-time'); await act('staff-time','staff_need_more_time'); await emptyPointers();
  await act('staff-time','need_more_time'); await act('staff-time','left_queue');
  await call('compat'); await app.changeWindowState(wid,shift,'pause');
  await complete('compat'); await emptyPointers();
  await app.changeWindowState(wid,shift,'resume');
  // Legacy called record without assignment/new fields, seeded only through emulator owner access.
  const legacy=await newTicket('legacy'); assert.equal(legacy.customerNeedMoreTimeAt,undefined);
  const seed=await fetch(base+'/sessions/'+sid+'/entries/legacy?updateMask.fieldPaths=status&updateMask.fieldPaths=calledAt',{
    method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer owner'},
    body:JSON.stringify({fields:{status:{stringValue:'called'},calledAt:{timestampValue:new Date().toISOString()}}})});
  assert(seed.ok,await seed.text());
  await app.completeCustomer(sid,'legacy',null,null,'manager'); assert.equal((await entry('legacy')).status,'completed');
  console.log('PASS called-state staff allowance, old direct/paused completion and legacy unassigned ticket');

  await call('race');
  const raced=await Promise.allSettled([act('race','no_show'),complete('race')]);
  assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);
  assert(['no_show','completed'].includes((await entry('race')).status)); await emptyPointers();
  await call('duplicate');
  const duplicates=await Promise.allSettled([act('duplicate','opted_out'),act('duplicate','opted_out')]);
  assert.equal(duplicates.filter(r=>r.status==='fulfilled').length,1); assert.equal((await events('duplicate')).length,1); await emptyPointers();
  console.log('PASS conflicting and duplicate concurrent actions have one winner');

  await call('attempts');
  const firstAttempt=(await entry('attempts')).callAttemptId;
  assert.equal(typeof firstAttempt,'string'); assert(firstAttempt.length > 0);
  assert.equal((await readDoc('windows',wid)).currentCallAttemptId,firstAttempt);
  await act('attempts','service_interrupted',firstAttempt);
  assert.equal((await entry('attempts')).callAttemptId,null);
  assert.equal((await readDoc('windows',wid)).currentCallAttemptId,null);
  await emptyPointers();
  await assert.rejects(act('attempts','opted_out',firstAttempt));
  await app.callNext(wid,shift,sid);
  const second=await entry('attempts'), secondAttempt=second.callAttemptId;
  assert.equal(typeof secondAttempt,'string'); assert.notEqual(secondAttempt,firstAttempt);
  const beforeWindow=await readDoc('windows',wid), beforeShift=await readDoc('shifts',shift);
  const stale=error=>error.code==='stale-call-attempt';
  for(const action of ['confirm_present','no_show','opted_out','staff_need_more_time','service_interrupted']) {
    await assert.rejects(act('attempts',action,firstAttempt),stale);
  }
  await assert.rejects(app.completeCustomer(sid,'attempts',wid,shift,'staff',firstAttempt),stale);
  await assert.rejects(app.completeCustomer(sid,'attempts',wid,shift),stale);
  await assert.rejects(act('attempts','confirm_present',null),stale);
  assert.deepEqual(await entry('attempts'),second);
  assert.deepEqual(await readDoc('windows',wid),beforeWindow);
  assert.deepEqual(await readDoc('shifts',shift),beforeShift);
  assert.equal((await events('attempts')).length,1);
  assert.equal((await events('attempts'))[0].data().callAttemptId,firstAttempt);
  const competing=await Promise.allSettled([
    act('attempts','confirm_present',secondAttempt),
    act('attempts','service_interrupted',firstAttempt),
    app.completeCustomer(sid,'attempts',wid,shift,'staff',firstAttempt)
  ]);
  assert.equal(competing[0].status,'fulfilled');
  for(const r of competing.slice(1)) { assert.equal(r.status,'rejected'); assert.equal(r.reason.code,'stale-call-attempt'); }
  const inProgress=await entry('attempts');
  assert.equal(inProgress.status,'in_progress'); assert.equal(inProgress.callAttemptId,secondAttempt);
  assert.equal(inProgress.calledAt.toMillis(),second.calledAt.toMillis());
  assert.equal((await readDoc('windows',wid)).currentCallAttemptId,secondAttempt);
  const finishing=await Promise.allSettled([
    app.completeCustomer(sid,'attempts',wid,shift,'staff',secondAttempt),
    act('attempts','opted_out',firstAttempt)
  ]);
  assert.equal(finishing[0].status,'fulfilled'); assert.equal(finishing[1].status,'rejected');
  assert.equal((await entry('attempts')).status,'completed'); await emptyPointers();
  assert.equal((await readDoc('windows',wid)).currentCallAttemptId,null);
  console.log('PASS unique call attempts, invalidation, stale/omitted tokens, concurrent stale actions and valid completion');

  await newTicket('rules');
  await denied(sdk.updateDoc(entryDoc('rules'),{status:'in_progress',confirmedPresentAt:sdk.serverTimestamp()}));
  await denied(sdk.updateDoc(entryDoc('rules'),{status:'no_show',noShowAt:sdk.serverTimestamp()}));
  await act('rules','need_more_time');
  await denied(sdk.updateDoc(entryDoc('rules'),{customerNeedMoreTimeAt:sdk.serverTimestamp()}));
  await app.callNext(wid,shift,sid);
  await denied(sdk.updateDoc(entryDoc('rules'),{status:'in_progress',confirmedPresentAt:sdk.serverTimestamp(),calledAt:sdk.Timestamp.fromMillis(0)}));
  await act('rules','confirm_present');
  await denied(sdk.updateDoc(entryDoc('rules'),{status:'no_show',noShowAt:sdk.serverTimestamp()}));
  await act('rules','staff_need_more_time'); await app.callNext(wid,shift,sid);
  await denied(sdk.updateDoc(entryDoc('rules'),{status:'waiting',staffNeedMoreTimeAt:sdk.serverTimestamp()}));
  await act('rules','opted_out');
  await denied(sdk.updateDoc(entryDoc('rules'),{status:'completed',completedAt:sdk.serverTimestamp()}));
  await newTicket('old-cancel'); await sdk.updateDoc(entryDoc('old-cancel'),{status:'cancelled',cancelledAt:sdk.serverTimestamp()});
  assert.equal((await entry('old-cancel')).status,'cancelled');
  console.log('PASS rule transition denials, timestamp immutability, allowance limits and legacy cancellation');
} finally { await sdk.terminate(app.db); }
