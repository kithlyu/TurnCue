// Only capacity integration: fixture backdating uses the isolated emulator's
// owner API; actual exclusion/renewal use the unchanged 4F-4A transactions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project=testProject("capacity"); await compileRules(project);
const server=await startBrowserServer(project), origin="http://127.0.0.1:"+server.address().port;
const emulator="http://127.0.0.1:8787", errors=[], external=[];
let browser;
try {
  browser=await chromium.launch({headless:true}); const context=await browser.newContext();
  await context.route("**/*",route=>{
    const url=new URL(route.request().url());
    if([origin,emulator].includes(url.origin)) return route.continue();
    if(url.origin==="https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js","/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) {
      let body=fs.readFileSync(path.join(process.env.TURNCUE_TEST_ASSETS,path.basename(url.pathname)),"utf8");
      if(url.pathname.endsWith("firebase-firestore.js")) {
        const start=body.lastIndexOf("export{"); assert(start>=0);
        body=body.slice(0,start)+body.slice(start).replace(/([,{])onSnapshot(?=[,}])/,"$1onSnapshot as originalOnSnapshot")
          +"\nfunction countedSnapshot(...args){globalThis.subscriptionStarts=(globalThis.subscriptionStarts||0)+1;return onSnapshot(...args);} export {countedSnapshot as onSnapshot};";
      }
      return route.fulfill({body,contentType:"text/javascript"});
    }
    if(!(url.origin==="https://www.google.com" && url.pathname==="/images/cleardot.gif")) external.push(url.href);
    return route.abort();
  });
  const page=await context.newPage(); page.on("pageerror",e=>errors.push(e.message));
  await page.goto(origin+"/business.html"); await expect(page.locator("#sessionStatus")).toHaveText("Queue session ready");
  const f=await page.evaluate(async()=>{
    const app=await import("/turncue.js"),join=await import("/join-entry.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const sid=await app.initializeTurnCue(), scope={businessId:app.BUSINESS_ID,locationId:app.LOCATION_ID,queueId:app.QUEUE_ID}, assignments=[];
    for(let i=0;i<3;i++) {const wid=await app.saveWindow(null,"Capacity "+i,true),code=await app.registerStaff("Capacity Staff "+i,"staff"),p=await app.findStaff(code);assignments.push({wid,staffId:p.id,shift:await app.startShift(p.id,wid)});}
    await join.joinEntry(app.db,{...scope,sessionId:sid,entryId:"assigned"});
    await app.callNext(assignments[2].wid,assignments[2].shift,sid);
    for(let i=0;i<9;i++) await join.joinEntry(app.db,{...scope,sessionId:sid,entryId:"waiting-"+i});
    for(let i=0;i<3;i++) await sdk.setDoc(sdk.doc(app.db,"queues",app.QUEUE_ID,"serviceSamples","pace-"+i),{...scope,sessionId:sid,entryId:"pace-"+i,windowId:assignments[2].wid,shiftId:assignments[2].shift,
      calledAt:sdk.Timestamp.fromMillis(Date.now()-480000),completedAt:sdk.serverTimestamp(),durationSeconds:null,durationMinutes:null,cleanEligible:true,exclusionReason:null,recordedAt:sdk.serverTimestamp()});
    return {sid,assignments,calculationNow:Date.now()};
  });
  async function inspect() {return page.evaluate(async f=>{
    const app=await import("/turncue.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js"),eta=await import("/eta.js"),fair=await import("/queue-fairness.js");
    const rows=async(...p)=>(await sdk.getDocsFromServer(sdk.collection(app.db,...p))).docs.map(d=>({id:d.id,...d.data()}));
    const windows=await rows("windows"),entries=await rows("sessions",f.sid,"entries"),samples=await rows("queues",app.QUEUE_ID,"serviceSamples"),waiting=entries.filter(e=>e.status==="waiting").sort(fair.compareWaiting),now=f.calculationNow;
    const args={samples,windows,waitingEntries:waiting,entryId:"waiting-8",now};
    const fairnessArgs={customer:waiting.find(e=>e.id==="waiting-0"),waiting,windows,samples,nextTicketNumber:111,now};
    let fairness;try{fairness=fair.fairnessPosition(fairnessArgs);}catch(e){fairness={code:e.code};}
    const estimate=eta.estimateWait(args),eligible=windows.filter(eta.countsAsServiceCapacity);
    let referenceFairness;try{referenceFairness=fair.fairnessPosition({...fairnessArgs,windows:eligible});}catch(e){referenceFairness={code:e.code};}
    return JSON.parse(JSON.stringify({windows,entries,samples,shifts:await rows("shifts"),staff:await rows("staff"),events:await rows("windowEvents"),
      estimate,copy:eta.etaCopy(estimate),fairness,referenceFairness,referenceEta:eta.estimateWait({...args,windows:eligible}),eligible:eligible.map(w=>w.id),subscriptions:globalThis.subscriptionStarts}));
  },f);}
  const metadata=["presenceStaffId","presenceShiftId","lastPresenceAt","lastPresenceBrowserId","capacityExcludedAt"];
  const operational=s=>({windows:s.windows.map(w=>Object.fromEntries(Object.entries(w).filter(([k])=>!metadata.includes(k)))),entries:s.entries,samples:s.samples,shifts:s.shifts,staff:s.staff,events:s.events});
  const call=(name,a,extra=[])=>page.evaluate(async({name,a,extra})=>(await import("/turncue.js"))[name](a.wid,a.staffId,a.shift,...extra),{name,a,extra});
  const renew=(a,id)=>call("renewWindowPresence",a,[id]);
  async function age(a) {const response=await fetch(`${emulator}/v1/projects/${project}/databases/(default)/documents/windows/${a.wid}?updateMask.fieldPaths=lastPresenceAt`,{
    method:"PATCH",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:JSON.stringify({fields:{lastPresenceAt:{timestampValue:new Date(Date.now()-300001).toISOString()}}})});assert(response.ok,await response.text());}
  let s=await inspect(); const baseline=operational(s),listeners=s.subscriptions;
  assert.equal(s.eligible.length,3); const legacyFairness=s.fairness;
  for(const a of f.assignments) await renew(a,"reporter-"+a.wid);
  s=await inspect();assert.equal(s.eligible.length,3);assert.deepEqual(s.fairness,legacyFairness);assert.deepEqual(operational(s),baseline);
  assert.deepEqual(await page.evaluate(async()=>{
    const {countsAsServiceCapacity:eligible}=await import("/eta.js"),stamp={toMillis:()=>1};
    const w={active:true,state:"active",currentShiftId:"new-shift",currentStaffId:"new-staff"};
    return [eligible(w),eligible({...w,lastPresenceAt:stamp,presenceStaffId:"old-staff",presenceShiftId:"old-shift"}),
      ...[{state:"paused"},{active:false},{state:"available",currentShiftId:null},{retired:true}].map(change=>eligible({...w,...change,lastPresenceAt:stamp,presenceStaffId:"new-staff",presenceShiftId:"new-shift"}))];
  }),[true,false,false,false,false,false]);
  console.log("PASS legacy/valid presence, stale assignment rejection and paused/inactive/ended/retired exclusion");
  await age(f.assignments[2]);assert.equal(await call("excludeWindowCapacity",f.assignments[2]),true);
  s=await inspect();assert.equal(s.eligible.length,2);assert.deepEqual(s.estimate,s.referenceEta);assert.deepEqual(s.fairness,s.referenceFairness);
  assert.notEqual(s.fairness.position,legacyFairness.position,"Fairness must use two slots rather than three");assert.equal(s.estimate.minutes,4*s.estimate.paceMinutes);
  assert.deepEqual(operational(s),baseline);assert.equal(s.subscriptions,listeners);
  for(const a of f.assignments.slice(0,2)){await age(a);await call("excludeWindowCapacity",a);}
  s=await inspect();assert.equal(s.eligible.length,0);assert.equal(s.estimate.minutes,null);assert.equal(s.estimate.mode,"no_capacity");
  assert.deepEqual(s.copy,{title:"Service is temporarily not moving.",detail:"Your place in line is saved."});assert.equal(s.fairness.code,"eta-unavailable");
  const denied=await page.evaluate(async sid=>{try{await (await import("/turncue.js")).requestNeedMoreTime(sid,"waiting-0");return null;}catch(e){return e.code;}},f.sid);
  assert.equal(denied,"eta-unavailable");assert.deepEqual(operational(await inspect()),baseline);
  console.log("PASS mixed ETA/fairness consistency, all-capacity fallback, unavailable Need More Time and unchanged lifecycle/assignment/timing/order/history/samples");
  await renew(f.assignments[0],"reconnected");s=await inspect();assert.equal(s.eligible.length,1);assert.equal(s.estimate.minutes,8*s.estimate.paceMinutes);
  await age(f.assignments[0]);
  await page.evaluate(async a=>{const app=await import("/turncue.js");await Promise.allSettled([app.excludeWindowCapacity(a.wid,a.staffId,a.shift),app.renewWindowPresence(a.wid,a.staffId,a.shift,"race-winner")]);},f.assignments[0]);
  s=await inspect();assert.equal(s.eligible.length,1);assert.deepEqual(operational(s),baseline);assert.equal(s.subscriptions,listeners);
  // Deliberate Need More Time still uses the existing proposal/confirmation and
  // one-use rules. Presence itself has made no queue mutation.
  const proposal=await page.evaluate(async sid=>(await import("/turncue.js")).requestNeedMoreTime(sid,"waiting-0"),f.sid);
  assert.equal(proposal.targetMinutes,Math.max(10,s.estimate.paceMinutes));
  await page.evaluate(async({sid,id})=>(await import("/turncue.js")).confirmNeedMoreTime(sid,"waiting-0",id),{sid:f.sid,id:proposal.proposalId});
  s=await inspect();const moved=s.entries.find(e=>e.id==="waiting-0");assert.equal(moved.status,"waiting");assert(moved.customerNeedMoreTimeAt);
  const second=await page.evaluate(async sid=>{try{await (await import("/turncue.js")).requestNeedMoreTime(sid,"waiting-0");return null;}catch(e){return e.message;}},f.sid);
  assert.equal(second,"Need More Time is not available for this ticket.");assert.deepEqual(s.entries.find(e=>e.id==="assigned"),baseline.entries.find(e=>e.id==="assigned"));
  assert.deepEqual(s.windows.map(w=>Object.fromEntries(Object.entries(w).filter(([k])=>!metadata.includes(k)))),baseline.windows);
  assert.deepEqual(s.samples,baseline.samples);assert.deepEqual(s.events,baseline.events);assert.equal(s.subscriptions,listeners);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log("PASS authoritative renewal/race capacity restoration, existing proposal/confirmation/one-use fairness, no duplicate listeners or unexpected requests/errors");
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
