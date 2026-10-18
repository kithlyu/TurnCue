// Focused queue fairness integration and rules checks; isolated local emulator.
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

  if (identifier.endsWith("turncue.js")) source = source.replace("const candidateRef = candidates.docs[0].ref;", "const candidateRef = candidates.docs[0].ref; await globalThis.queueGate?.(candidateRef.id, windowId);");
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


const joinModule = await load(path.join(root,'join-entry.js')); await joinModule.evaluate();
const join=joinModule.namespace.joinEntry;
const { compareWaiting }=await import('../queue-fairness.js');
let sid, wid, shift, wid2, shift2, sampleBatch=0;
const read=async (...parts)=>(await sdk.getDocFromServer(sdk.doc(app.db,...parts))).data();
const ticket=id=>read('sessions',sid,'entries',id);
const proposalDoc=(id,p)=>sdk.doc(app.db,'sessions',sid,'entries',id,'proposals',p.proposalId);
const add=id=>join(app.db,{...scope,sessionId:sid,entryId:id});
const act=async (id,action,w=wid,s=shift)=>app.transitionTicket(sid,id,action,w,s,'staff',(await ticket(id)).callAttemptId??null);
const ordered=async ()=>(await sdk.getDocsFromServer(sdk.query(sdk.collection(app.db,'sessions',sid,'entries'),sdk.where('status','==','waiting')))).docs.map(d=>({id:d.id,...d.data()})).sort(compareWaiting);
const ids=async ()=>(await ordered()).map(e=>e.id);
const propose=id=>app.requestNeedMoreTime(sid,id);
const confirm=(id,p)=>app.confirmNeedMoreTime(sid,id,p.proposalId);
const unavailable=e=>e.code==='eta-unavailable';
async function pace(minutes,count=40) {
  const batch=sdk.writeBatch(app.db); sampleBatch++;
  for(let i=0;i<count;i++) {
    const id=`sample-${sampleBatch}-${i}`;
    batch.set(sdk.doc(app.db,'queues',scope.queueId,'serviceSamples',id),{
      ...scope,sessionId:sid,entryId:id,windowId:wid,shiftId:shift,
      calledAt:sdk.Timestamp.fromMillis(Date.now()-minutes*60000),completedAt:sdk.serverTimestamp(),
      durationSeconds:null,durationMinutes:null,cleanEligible:true,exclusionReason:null,recordedAt:sdk.serverTimestamp()
    });
  }
  await batch.commit();
}
async function clearWaiting() { for(const e of await ordered()) await act(e.id,'left_queue'); }
async function windowReady(name) {
  const w=await app.saveWindow(null,name,true), code=await app.registerStaff(name+' Staff','staff'), person=await app.findStaff(code);
  return [w,await app.startShift(person.id,w)];
}
function holdCandidate() {
  let reached,release,used=false;
  const selected=new Promise(resolve=>reached=resolve), resume=new Promise(resolve=>release=resolve);
  globalThis.queueGate=async id=>{if(!used){used=true;reached(id);await resume;}};
  return {selected,release:()=>{globalThis.queueGate=null;release();}};
}
try {
  sid=await app.initializeTurnCue(); [wid,shift]=await windowReady('Fairness 1');
  await add('unavailable'); const noPace=await ticket('unavailable');
  await assert.rejects(propose('unavailable'),unavailable);
  await pace(4,2); await assert.rejects(propose('unavailable'),unavailable);
  assert.deepEqual(await ticket('unavailable'),noPace);
  await app.callNext(wid,shift,sid); const noStaffPace=await ticket('unavailable');
  await assert.rejects(act('unavailable','staff_need_more_time'),unavailable);
  assert.deepEqual(await ticket('unavailable'),noStaffPace);
  assert.equal((await read('windows',wid)).currentEntryId,'unavailable');
  await act('unavailable','service_interrupted');
  await pace(4,1);
  await app.changeWindowState(wid,shift,'pause');
  const pausedTicket=await ticket('unavailable'); await assert.rejects(propose('unavailable'),unavailable);
  assert.deepEqual(await ticket('unavailable'),pausedTicket);
  await app.changeWindowState(wid,shift,'resume'); await clearWaiting();
  console.log('PASS unavailable/insufficient samples or capacity changes neither order nor allowances');

  for(const id of ['a','b','c','d','e']) await add(id);
  const before=await ticket('a'), orderBefore=await ids(), sessionBefore=await read('sessions',sid);
  const cancelled=await propose('a');
  assert.equal(cancelled.targetMinutes,10); assert.equal(cancelled.position,3);
  assert.equal(cancelled.expiresAt> Date.now(),true);
  assert.deepEqual(await ticket('a'),before); assert.deepEqual(await ids(),orderBefore);
  assert.deepEqual(await read('sessions',sid),sessionBefore);
  await app.cancelNeedMoreTime(sid,'a',cancelled.proposalId);
  await assert.rejects(confirm('a',cancelled)); assert.deepEqual(await ticket('a'),before);
  const expired=await propose('a');
  const expire=await fetch(base+'/sessions/'+sid+'/entries/a/proposals/'+expired.proposalId+'?updateMask.fieldPaths=createdAt',{
    method:'PATCH',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},
    body:JSON.stringify({fields:{createdAt:{timestampValue:new Date(Date.now()-21000).toISOString()}}})
  });
  assert(expire.ok,await expire.text());
  await assert.rejects(confirm('a',expired),/expired/);
  await assert.rejects(sdk.updateDoc(proposalDoc('a',expired),{status:'confirmed'}),e=>e.code==='permission-denied');
  assert.deepEqual(await ticket('a'),before); assert.deepEqual(await ids(),orderBefore);
  console.log('PASS proposal-only preview, 20-second expiry and cancellation leave queue/allowance unchanged');

  const preview=await propose('a'); assert.equal(preview.position,3);
  await pace(12);
  const applied=await confirm('a',preview);
  assert(applied.targetMinutes>=12 && applied.targetMinutes<12.1);
  assert.equal(applied.position,1); assert(applied.additionalMinutes>=applied.targetMinutes);
  assert.deepEqual(await ids(),['b','a','c','d','e']);
  assert.equal((await ticket('a')).ticketNumber,before.ticketNumber);
  assert.equal((await ticket('a')).joinedAt.toMillis(),before.joinedAt.toMillis());
  await assert.rejects(confirm('a',preview)); await assert.rejects(propose('a'));
  console.log('PASS fresh confirmation calculation uses learned interval above 10, moves backward once, preserves identity/history');

  await pace(4);
  const short=await propose('d'); assert.equal(short.targetMinutes,10); assert.equal(short.position,4);
  const shortResult=await confirm('d',short);
  assert(shortResult.additionalMinutes<10); assert.deepEqual(await ids(),['b','a','c','e','d']);
  const tailBefore=await ticket('d');
  await assert.rejects(sdk.updateDoc(sdk.doc(app.db,'sessions',sid,'entries','e'),{status:'waiting',queueOrder:0,customerNeedMoreTimeAt:sdk.serverTimestamp()}),e=>e.code==='permission-denied');
  assert.deepEqual(await ticket('d'),tailBefore);
  await clearWaiting();
  console.log('PASS short numeric queue uses back without artificial delay; forward movement rejected');

  await add('recalc'); const small=await propose('recalc'); assert.equal(small.position,0);
  for(const id of ['new1','new2','new3']) await add(id);
  const live=await confirm('recalc',small); assert.equal(live.position,3);
  assert.deepEqual(await ids(),['new1','new2','new3','recalc']);
  await clearWaiting();
  console.log('PASS confirmation also recalculates live queue membership instead of committing preview');

  await add('loss'); const loss=await propose('loss'), lossBefore=await ticket('loss');
  await app.changeWindowState(wid,shift,'pause');
  await assert.rejects(confirm('loss',loss),unavailable); assert.deepEqual(await ticket('loss'),lossBefore);
  await app.changeWindowState(wid,shift,'resume'); await clearWaiting();

  await add('race-a'); await add('race-b'); const raceProposal=await propose('race-a');
  const gate=holdCandidate(), calling=app.callNext(wid,shift,sid);
  assert.equal(await gate.selected,'race-a'); await confirm('race-a',raceProposal); gate.release();
  assert.equal(await calling,(await ticket('race-b')).ticketLabel);
  assert.equal((await ticket('race-a')).status,'waiting'); await act('race-b','opted_out'); await clearWaiting();

  await add('call-wins'); await add('call-next'); const losingProposal=await propose('call-wins');
  await app.callNext(wid,shift,sid); await assert.rejects(confirm('call-wins',losingProposal));
  assert.equal((await ticket('call-wins')).customerNeedMoreTimeAt,undefined);
  await assert.rejects(act('call-wins','left_queue')); await act('call-wins','opted_out'); await clearWaiting();

  await add('leave-a'); await add('leave-b');
  const leaveGate=holdCandidate(), leavingCall=app.callNext(wid,shift,sid);
  assert.equal(await leaveGate.selected,'leave-a'); await act('leave-a','left_queue'); leaveGate.release();
  assert.equal(await leavingCall,(await ticket('leave-b')).ticketLabel);
  assert.equal((await ticket('leave-a')).status,'left_queue'); await act('leave-b','opted_out');
  console.log('PASS deterministic CALL/NMT and CALL/leave races, including called-first rejection');

  await add('staff'); await app.callNext(wid,shift,sid); const attempt1=(await ticket('staff')).callAttemptId;
  for(const id of ['s1','s2','s3','s4']) await add(id);
  await act('staff','confirm_present'); await act('staff','staff_need_more_time');
  assert.deepEqual(await ids(),['s1','s2','s3','staff','s4']);
  const deferred=await ticket('staff'); assert.equal(deferred.callAttemptId,null); assert(deferred.staffNeedMoreTimeAt);
  assert.equal(deferred.customerNeedMoreTimeAt,undefined);
  assert.equal((await read('windows',wid)).currentEntryId,null); assert.equal((await read('shifts',shift)).currentEntryId,null);
  assert.equal(await read('queues',scope.queueId,'serviceSamples','staff'),undefined);
  const deferredEvents=(await sdk.getDocsFromServer(sdk.collection(app.db,'sessions',sid,'entries','staff','events'))).docs.map(d=>d.data());
  assert(deferredEvents.some(e=>e.type==='staff_need_more_time'&&e.callAttemptId===attempt1));
  await confirm('staff',await propose('staff'));
  assert((await ticket('staff')).customerNeedMoreTimeAt);
  for(const id of ['s1','s2','s3','s4']) await act(id,'left_queue');
  await app.callNext(wid,shift,sid); const recalled=await ticket('staff');
  assert.notEqual(recalled.callAttemptId,attempt1); assert(recalled.calledAt.toMillis()>=deferred.calledAt.toMillis());
  await assert.rejects(act('staff','staff_need_more_time')); await act('staff','opted_out');
  console.log('PASS shared staff fairness, independent allowances, atomic release, history and fresh call attempt');

  [wid2,shift2]=await windowReady('Fairness 2');
  for(const id of ['capacity','v1','v2','v3','v4','v5','v6']) await add(id);
  const multi=await propose('capacity'); assert.equal(multi.position,6); // 3 waves at 4 minutes, two windows.
  await clearWaiting();

  await add('front-old'); await app.callNext(wid,shift,sid);
  await add('front-new'); await add('front-last');
  const frontGate=holdCandidate(), frontCall=app.callNext(wid2,shift2,sid);
  assert.equal(await frontGate.selected,'front-new'); await act('front-old','service_interrupted'); frontGate.release();
  assert.equal(await frontCall,(await ticket('front-old')).ticketLabel);
  const restored=await ticket('front-old'); assert.equal(restored.customerNeedMoreTimeAt,undefined); assert.equal(restored.staffNeedMoreTimeAt,undefined);
  await act('front-old','opted_out',wid2,shift2); await clearWaiting();

  // A formerly deferred/newer ticket must also return before older waiting tickets.
  await add('older'); await add('interrupted');
  await app.callNext(wid,shift,sid); await app.callNext(wid2,shift2,sid);
  await act('older','service_interrupted'); await act('interrupted','service_interrupted',wid2,shift2);
  assert.deepEqual(await ids(),['interrupted','older']); await clearWaiting();
  console.log('PASS existing multi-window capacity model and interruption-to-front revision fence');

  await add('two-a'); await add('two-b');
  let releaseBoth; const bothReady=new Promise(resolve=>releaseBoth=resolve), seen=new Set();
  globalThis.queueGate=async (id,w)=>{if(seen.has(w))return; seen.add(w);if(seen.size===2)releaseBoth();await bothReady;};
  const calls=await Promise.all([app.callNext(wid,shift,sid),app.callNext(wid2,shift2,sid)]); globalThis.queueGate=null;
  assert.equal(new Set(calls).size,2);
  for(const id of ['two-a','two-b']) {const t=await ticket(id);await act(id,'opted_out',t.calledWindowId,t.calledByShiftId);}

  await add('same-a'); await add('same-b');
  const same=await Promise.allSettled([app.callNext(wid,shift,sid),app.callNext(wid,shift,sid)]);
  assert.equal(same.filter(r=>r.status==='fulfilled').length,1);
  const current=(await read('windows',wid)).currentEntryId; await act(current,'opted_out'); await clearWaiting();
  await add('paused'); await app.changeWindowState(wid,shift,'pause'); await assert.rejects(app.callNext(wid,shift,sid),/Resume/);
  await app.changeWindowState(wid,shift,'resume'); await assert.rejects(app.callNext(wid,'old-shift',sid)); await clearWaiting();
  console.log('PASS competing windows, same-window calls, pause/stale shift guards and legacy unranked tickets');
} finally { globalThis.queueGate=null; await sdk.terminate(app.db); }
