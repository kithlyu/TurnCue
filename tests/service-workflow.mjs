// Focused staff service workflow integration and rules checks; isolated local emulator.
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

  if (identifier.endsWith("turncue.js")) source = source.replace("const nextRef = candidates.docs[0]?.ref || null;", "const nextRef = candidates.docs[0]?.ref || null; await globalThis.pairGate?.(nextRef?.id);");
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


const joinModule=await load(path.join(root,'join-entry.js')); await joinModule.evaluate();
const {serviceTiming,ARRIVAL_WINDOW_MS}=await import('../service-workflow.js');
let sid,wid,shift;
const read=async(...p)=>(await sdk.getDocFromServer(sdk.doc(app.db,...p))).data();
const ticket=id=>read('sessions',sid,'entries',id);
const add=id=>joinModule.namespace.joinEntry(app.db,{...scope,sessionId:sid,entryId:id});
const transition=async(id,action,w=wid,s=shift)=>app.transitionTicket(sid,id,action,w,s,'staff',(await ticket(id)).callAttemptId??null);
const paired=async(id,outcome,after,w=wid,s=shift)=>app.resolveAndContinue(sid,id,w,s,(await ticket(id)).callAttemptId??null,outcome,after);
async function call(id){await add(id);await app.callNext(wid,shift,sid);assert.equal((await ticket(id)).status,'called');}
async function backdate(id){
  const t=new Date(Date.now()-ARRIVAL_WINDOW_MS-1000).toISOString();
  for(const [p,f] of [['sessions/'+sid+'/entries/'+id,'calledAt'],['windows/'+wid,'currentEntryCalledAt']]) {
    const response=await fetch(base+'/'+p+'?updateMask.fieldPaths='+f,{method:'PATCH',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body:JSON.stringify({fields:{[f]:{timestampValue:t}}})});
    assert(response.ok,await response.text());
  }
}
async function assigned(id,state='active',w=wid,s=shift){
  const window=await read('windows',w),staffShift=await read('shifts',s);
  assert.equal(window.currentEntryId,id);assert.equal(staffShift.currentEntryId,id);
  assert.equal(window.state,state);assert.equal(staffShift.state,state);
  if(id){const t=await ticket(id);assert.equal(window.currentCallAttemptId,t.callAttemptId);assert.equal(window.currentEntryCalledAt.toMillis(),t.calledAt.toMillis());}
  else {assert.equal(window.currentCallAttemptId,null);assert.equal(window.currentSessionId,null);assert.equal(staffShift.currentSessionId,null);}
}
async function sample(id){return read('queues',scope.queueId,'serviceSamples',id);}
async function sampleFixture(id){await sdk.setDoc(sdk.doc(app.db,'queues',scope.queueId,'serviceSamples',id),{...scope,sessionId:sid,entryId:id,windowId:wid,shiftId:shift,calledAt:sdk.Timestamp.fromMillis(Date.now()-600000),completedAt:sdk.serverTimestamp(),durationSeconds:null,durationMinutes:null,cleanEligible:true,exclusionReason:null,recordedAt:sdk.serverTimestamp()});}
try{
  sid=await app.initializeTurnCue();wid=await app.saveWindow(null,'Workflow 1',true);
  const code=await app.registerStaff('Workflow Staff','staff'),person=await app.findStaff(code);shift=await app.startShift(person.id,wid);
  await call('present');const called=await ticket('present'),at=called.calledAt.toMillis();
  assert.equal(serviceTiming(called,called.callAttemptId,at+119999).arrivalDecision,false);
  assert.equal(serviceTiming(called,called.callAttemptId,at+120000).arrivalDecision,true);
  assert.equal(serviceTiming(called,'older-attempt',at+130000).active,false);
  await assert.rejects(paired('present','no_show','pause'),/arrival decision/);
  await app.transitionTicket(sid,'present','confirm_present',wid,shift,'customer',called.callAttemptId);
  const present=await ticket('present');assert.equal(present.calledAt.toMillis(),at);
  assert.equal(serviceTiming(present,present.callAttemptId,at+130000).arrivalDecision,false);
  assert.equal(serviceTiming(present,present.callAttemptId,at+130000).elapsedSeconds,130);
  await add('next');await paired('present','completed','next');await assigned('next');
  assert.equal((await ticket('present')).status,'completed');assert.equal((await sample('present')).calledAt.toMillis(),at);
  assert((await ticket('next')).calledAt.toMillis()>=at);
  await transition('next','confirm_present');await paired('next','completed','pause');await assigned(null,'paused');
  assert.equal((await sample('next')).cleanEligible,true); // Pausing after completion does not taint service.
  console.log('PASS arrival boundary, customer confirmation, unchanged service clock, complete-next and complete-pause');

  await app.changeWindowState(wid,shift,'resume');await call('absent');await add('after-absent');await backdate('absent');
  await paired('absent','no_show','next');assert.equal((await ticket('absent')).status,'no_show');assert.equal(await sample('absent'),undefined);await assigned('after-absent');
  await backdate('after-absent');await paired('after-absent','no_show','pause');await assigned(null,'paused');
  assert.equal((await ticket('after-absent')).status,'no_show');
  await app.changeWindowState(wid,shift,'resume');await call('empty');await transition('empty','confirm_present');
  await paired('empty','completed','next');await assigned(null);
  await add('future');await assigned(null);assert.equal((await ticket('future')).status,'waiting');
  await app.callNext(wid,shift,sid);await backdate('future');await paired('future','no_show','next');await assigned(null);
  console.log('PASS both no-show pairs, no service samples, empty queue stays staffed/idle and future JOIN is not auto-called');

  await call('paused');await transition('paused','confirm_present');await app.changeWindowState(wid,shift,'pause');
  await paired('paused','completed','pause');await assigned(null,'paused');assert.equal((await sample('paused')).cleanEligible,false);
  await app.changeWindowState(wid,shift,'resume');await call('paused-next');await transition('paused-next','confirm_present');await app.changeWindowState(wid,shift,'pause');await add('resume-next');
  await paired('paused-next','completed','next');await assigned('resume-next');await transition('resume-next','opted_out');await assigned(null);
  console.log('PASS paused completion and explicit complete-next from a paused owned window');

  await call('stale');const old=(await ticket('stale')).callAttemptId;
  await transition('stale','service_interrupted');await app.callNext(wid,shift,sid);const fresh=await ticket('stale');
  await assert.rejects(app.transitionTicket(sid,'stale','confirm_present',wid,shift,'customer',old),e=>e.code==='stale-call-attempt');
  await assert.rejects(app.resolveAndContinue(sid,'stale',wid,shift,old,'completed','pause'),e=>e.code==='stale-call-attempt');
  assert.deepEqual(await ticket('stale'),fresh);await transition('stale','confirm_present');await paired('stale','completed','pause');
  await app.changeWindowState(wid,shift,'resume');await call('presence-race');await backdate('presence-race');
  const raceTicket=await ticket('presence-race');
  const presenceRace=await Promise.allSettled([
    app.transitionTicket(sid,'presence-race','confirm_present',wid,shift,'customer',raceTicket.callAttemptId),
    app.resolveAndContinue(sid,'presence-race',wid,shift,raceTicket.callAttemptId,'no_show','pause')
  ]);
  assert.equal(presenceRace.filter(r=>r.status==='fulfilled').length,1);
  if((await ticket('presence-race')).status==='in_progress')await paired('presence-race','completed','pause');
  await assigned(null,'paused');await app.changeWindowState(wid,shift,'resume');
  console.log('PASS stale arrivals/pairs rejected after recall; presence and no-show have one winner');

  await call('pair-race');await transition('pair-race','confirm_present');await add('pair-next');const pairAttempt=(await ticket('pair-race')).callAttemptId;
  const pairRace=await Promise.allSettled([
    app.resolveAndContinue(sid,'pair-race',wid,shift,pairAttempt,'completed','next'),
    app.resolveAndContinue(sid,'pair-race',wid,shift,pairAttempt,'completed','pause')
  ]);
  assert.equal(pairRace.filter(r=>r.status==='fulfilled').length,1);assert.equal((await ticket('pair-race')).status,'completed');
  if((await read('windows',wid)).state==='paused'){await app.changeWindowState(wid,shift,'resume');await app.callNext(wid,shift,sid);}
  await assigned('pair-next');await transition('pair-next','opted_out');

  await call('rollback');await transition('rollback','confirm_present');await add('rollback-next');await sampleFixture('rollback');
  const oldTicket=await ticket('rollback'),oldWindow=await read('windows',wid),oldShift=await read('shifts',shift);
  await assert.rejects(paired('rollback','completed','next'),e=>e.code==='permission-denied');
  assert.deepEqual(await ticket('rollback'),oldTicket);assert.deepEqual(await read('windows',wid),oldWindow);assert.deepEqual(await read('shifts',shift),oldShift);
  assert.equal((await ticket('rollback-next')).status,'waiting');
  await assert.rejects(sdk.updateDoc(sdk.doc(app.db,'windows',wid),{currentEntryId:'rollback-next',lastActionAt:sdk.serverTimestamp(),updatedAt:sdk.serverTimestamp()}),e=>e.code==='permission-denied');
  await transition('rollback','opted_out');await transition('rollback-next','left_queue');
  console.log('PASS conflicting paired operations and injected commit denial leave no partial outcome/assignment');

  const wid2=await app.saveWindow(null,'Workflow 2',true),code2=await app.registerStaff('Other Staff','staff'),p2=await app.findStaff(code2),shift2=await app.startShift(p2.id,wid2);
  await call('current');await transition('current','confirm_present');await add('candidate1');await add('candidate2');
  let reached,release,used=false;const selected=new Promise(r=>reached=r),resume=new Promise(r=>release=r);
  globalThis.pairGate=async id=>{if(!used){used=true;reached(id);await resume;}};
  const pending=paired('current','completed','next');assert.equal(await selected,'candidate1');
  await app.callNext(wid2,shift2,sid);globalThis.pairGate=null;release();await pending;
  await assigned('candidate2');await assigned('candidate1','active',wid2,shift2);
  await transition('candidate2','opted_out');await transition('candidate1','opted_out',wid2,shift2);
  console.log('PASS paired next retries a candidate lost to another window with one completion');

  for(let i=0;i<3;i++)await sampleFixture('learn-'+i);
  await call('defer');await transition('defer','confirm_present');await add('waiting');const deferredAttempt=(await ticket('defer')).callAttemptId;
  await transition('defer','staff_need_more_time');const deferred=await ticket('defer');
  assert.equal(deferred.status,'waiting');assert.equal(deferred.callAttemptId,null);assert(deferred.staffNeedMoreTimeAt);assert.equal(deferred.customerNeedMoreTimeAt,undefined);
  assert(deferred.queueOrder>(await ticket('waiting')).ticketNumber);assert.equal(await sample('defer'),undefined);await assigned(null);
  await transition('waiting','left_queue');await app.callNext(wid,shift,sid);assert.notEqual((await ticket('defer')).callAttemptId,deferredAttempt);
  await transition('defer','confirm_present');await transition('defer','opted_out');await assigned(null);
  console.log('PASS staff Need More Time reuses 4B fairness, preserves allowances/history and opted-out cleanup');
}finally{globalThis.pairGate=null;await sdk.terminate(app.db);}
