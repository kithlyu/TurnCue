// Presence UX only. Expiry fixture writes use owner access in an isolated local
// emulator; real exclusion/renewal remain the existing production operations.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project=testProject("presence-ux");await compileRules(project);
const server=await startBrowserServer(project),origin="http://127.0.0.1:"+server.address().port,emulator="http://127.0.0.1:8787";
const errors=[],external=[];let browser;
try {
  browser=await chromium.launch({headless:true});const context=await browser.newContext();
  await context.route("**/*",route=>{
    const url=new URL(route.request().url());if([origin,emulator].includes(url.origin))return route.continue();
    if(url.origin==="https://www.gstatic.com"&&["/firebasejs/12.19.0/firebase-app.js","/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)){
      let body=fs.readFileSync(path.join(process.env.TURNCUE_TEST_ASSETS,path.basename(url.pathname)),"utf8");
      if(url.pathname.endsWith("firebase-firestore.js")){const start=body.lastIndexOf("export{");assert(start>=0);body=body.slice(0,start)+body.slice(start).replace(/([,{])onSnapshot(?=[,}])/,"$1onSnapshot as originalOnSnapshot")+"\nfunction counted(...args){globalThis.subscriptionStarts=(globalThis.subscriptionStarts||0)+1;return onSnapshot(...args);}export {counted as onSnapshot};";}
      return route.fulfill({body,contentType:"text/javascript"});
    }
    if(!(url.origin==="https://www.google.com"&&url.pathname==="/images/cleardot.gif"))external.push(url.href);return route.abort();
  });
  await context.route(origin+"/turncue.js",async route=>{
    const response=await route.fetch(),body=await response.text();
    const declaration="const browserId = crypto.randomUUID();";
    assert(body.includes(declaration),"Presence browser ID declaration required");
    await route.fulfill({response,body:body.replace(declaration,"const browserId = globalThis.testPresenceBrowserId = crypto.randomUUID();")});
  });
  const page=async()=>{const p=await context.newPage();p.on("pageerror",e=>errors.push(e.message));return p;};
  const manager=await page();await manager.goto(origin+"/business.html");await expect(manager.locator("#sessionStatus")).toHaveText("Queue session ready");
  const f=await manager.evaluate(async()=>{
    const app=await import("/turncue.js"),join=await import("/join-entry.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const sid=await app.initializeTurnCue(),wid=await app.saveWindow(null,"Presence UX",true),code=await app.registerStaff("UX Staff","staff"),p=await app.findStaff(code),shift=await app.startShift(p.id,wid);
    const legacy=await app.saveWindow(null,"Legacy UX",true),lc=await app.registerStaff("Legacy Staff","staff"),lp=await app.findStaff(lc);await app.startShift(lp.id,legacy);
    const inactive=await app.saveWindow(null,"Inactive UX",false),scope={businessId:app.BUSINESS_ID,locationId:app.LOCATION_ID,queueId:app.QUEUE_ID};
    await join.joinEntry(app.db,{...scope,sessionId:sid,entryId:"assigned"});await app.callNext(wid,shift,sid);
    await join.joinEntry(app.db,{...scope,sessionId:sid,entryId:"waiting"});
    for(let i=0;i<3;i++)await sdk.setDoc(sdk.doc(app.db,"queues",app.QUEUE_ID,"serviceSamples","sample-"+i),{...scope,sessionId:sid,entryId:"sample-"+i,windowId:wid,shiftId:shift,calledAt:sdk.Timestamp.fromMillis(Date.now()-480000),completedAt:sdk.serverTimestamp(),durationSeconds:null,durationMinutes:null,cleanEligible:true,exclusionReason:null,recordedAt:sdk.serverTimestamp()});
    return{sid,wid,shift,staffId:p.id,code,legacy,inactive};
  });
  const card=id=>manager.locator(`[data-window-id="${id}"]`),label=id=>card(id).locator(".window-presence");
  await expect(label(f.legacy)).toContainText("presence not yet established. Existing capacity is unchanged");await expect(label(f.inactive)).toContainText("Inactive");
  await expect(label(f.legacy)).not.toContainText("disconnected");
  const state=()=>manager.evaluate(async f=>{
    const app=await import("/turncue.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js"),eta=await import("/eta.js"),fair=await import("/queue-fairness.js");
    const read=async(...p)=>(await sdk.getDocFromServer(sdk.doc(app.db,...p))).data(),rows=async(...p)=>(await sdk.getDocsFromServer(sdk.collection(app.db,...p))).docs.map(d=>({id:d.id,...d.data()}));
    const window=await read("windows",f.wid),entries=await rows("sessions",f.sid,"entries"),samples=await rows("queues",app.QUEUE_ID,"serviceSamples"),windows=await rows("windows"),waiting=entries.filter(e=>e.status==="waiting").sort(fair.compareWaiting);
    const estimate=eta.estimateWait({windows,samples,waitingEntries:waiting,entryId:"waiting",now:window.currentEntryCalledAt?.toMillis?.()||0});
    return JSON.parse(JSON.stringify({window,entries,samples,events:await rows("windowEvents"),shift:await read("shifts",f.shift),staff:await read("staff",f.staffId),estimate,capacity:eta.countsAsServiceCapacity(window),subscriptions:globalThis.subscriptionStarts}));
  },f);
  const metadata=["presenceStaffId","presenceShiftId","lastPresenceAt","lastPresenceBrowserId","capacityExcludedAt"];
  const operational=s=>{const v=structuredClone(s);delete v.estimate;delete v.capacity;delete v.subscriptions;for(const key of metadata)delete v.window[key];return v;};
  const invoke=(name,args)=>manager.evaluate(async({name,args})=>(await import("/turncue.js"))[name](...args),{name,args});
  async function age(){const r=await fetch(`${emulator}/v1/projects/${project}/databases/(default)/documents/windows/${f.wid}?updateMask.fieldPaths=lastPresenceAt`,{method:"PATCH",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:JSON.stringify({fields:{lastPresenceAt:{timestampValue:new Date(Date.now()-300001).toISOString()}}})});assert(r.ok,await r.text());}
  const exclude=async()=>{await age();await invoke("excludeWindowCapacity",[f.wid,f.staffId,f.shift]);await expect(label(f.wid)).toContainText("capacity temporarily excluded");};
  const open=async(code=f.code)=>{const p=await page();await p.clock.install();await p.goto(origin+"/staff.html");await p.locator("#staffCode").fill(code);await p.locator("#entryForm button").click();await p.locator("#confirmButton").click();return p;};
  const network=(p,enabled)=>p.evaluate(async enabled=>{const app=await import("/turncue.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");await sdk[enabled?"enableNetwork":"disableNetwork"](app.db);},enabled);
  const connected=p=>expect(p.locator("#presenceNotice")).toHaveAttribute("data-state",/connected|restored/);
  let a=await open();await connected(a);await expect(label(f.wid)).toContainText("presence confirmed");await expect(label(f.wid)).toContainText("Last confirmed:");
  const called=await state(),count=await a.evaluate(()=>subscriptionStarts),managerCount=called.subscriptions,id=called.window.lastPresenceBrowserId;
  await network(a,false);await expect(a.locator("#presenceNotice")).toHaveAttribute("data-state","uncertain");
  await expect(a.locator("#assignment")).toContainText("Called:");await expect(a.locator("#serviceClock")).toContainText("Service time:");
  await expect(a.getByRole("button",{name:"PAUSE",exact:true})).toBeDisabled();await expect(a.getByRole("button",{name:"THEY'RE HERE",exact:true})).toBeEnabled();
  assert.deepEqual(operational(await state()),operational(called));
  await network(a,true);await connected(a);await expect(a.locator("#presenceNotice")).toContainText("Connection restored");
  assert.deepEqual(operational(await state()),operational(called));assert.equal(await a.evaluate(()=>subscriptionStarts),count);
  await exclude();await expect(a.locator("#presenceNotice")).toHaveAttribute("data-state","excluded");await expect(a.locator("#presenceNotice")).toContainText("Window active");
  await expect(a.locator("#assignment")).toContainText("Called:");assert.deepEqual(operational(await state()),operational(called));assert.equal((await state()).capacity,false);
  await a.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));await connected(a);await expect(label(f.wid)).toContainText("presence confirmed");
  console.log("PASS connected staff, CALLED/WAITING preservation, safe loss gates, restored state, active-but-excluded presentation and visibility renewal");
  const t=(await state()).entries.find(e=>e.id==="assigned");await invoke("transitionTicket",[f.sid,"assigned","confirm_present",f.wid,f.shift,"manager",t.callAttemptId]);
  await expect(a.locator("#assignment")).toContainText("Service in progress:");const progress=await state();
  await network(a,false);await expect(a.locator("#presenceNotice")).toHaveAttribute("data-state","uncertain");await expect(a.locator("#serviceClock")).toContainText("Service time:");
  let b=await open();await connected(b);const bid=await b.evaluate(()=>globalThis.testPresenceBrowserId);
  assert.equal(typeof bid,"string");assert.notEqual(bid,id);
  await expect.poll(async()=>{
    const w=(await state()).window;
    return {reporter:w.lastPresenceBrowserId,staff:w.presenceStaffId,shift:w.presenceShiftId,excluded:w.capacityExcludedAt};
  }).toEqual({reporter:bid,staff:f.staffId,shift:f.shift,excluded:null});
  assert.equal((await state()).window.lastPresenceBrowserId,bid);await a.close();
  const stamp=(await state()).window.lastPresenceAt;await b.clock.fastForward(120000);
  await expect.poll(async()=>JSON.stringify((await state()).window.lastPresenceAt)).not.toBe(JSON.stringify(stamp));
  await expect(label(f.wid)).toContainText("presence confirmed");assert.deepEqual(operational(await state()),operational(progress));
  await b.close();await exclude();assert.deepEqual(operational(await state()),operational(progress));
  const waitForReopenedReporter=async p=>{
    const reporter=await p.evaluate(()=>globalThis.testPresenceBrowserId);
    assert.equal(typeof reporter,"string");
    await expect.poll(async()=>{
      // state() reads windows/{f.wid} from the server, not a cached snapshot.
      const w=(await state()).window;
      return {reporter:w.lastPresenceBrowserId,staff:w.presenceStaffId,shift:w.presenceShiftId,
        currentStaff:w.currentStaffId,currentShift:w.currentShiftId,excluded:w.capacityExcludedAt};
    }).toEqual({reporter,staff:f.staffId,shift:f.shift,currentStaff:f.staffId,currentShift:f.shift,excluded:null});
    return reporter;
  };
  a=await open();await connected(a);const reopenedId=await waitForReopenedReporter(a);
  await expect(label(f.wid)).toContainText("presence confirmed");assert.notEqual(reopenedId,bid);
  await expect(a.locator("#assignment")).toContainText("Service in progress:");assert.deepEqual(operational(await state()),operational(progress));
  let lastId=(await state()).window.lastPresenceBrowserId;await a.close();a=await open();await connected(a);
  const nextReopenedId=await waitForReopenedReporter(a);assert.notEqual(nextReopenedId,lastId);
  const reopenedCount=await a.evaluate(()=>subscriptionStarts);
  for(let i=0;i<3;i++)await a.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
  await connected(a);assert.equal(await a.evaluate(()=>subscriptionStarts),reopenedCount);
  await network(manager,false);await expect(manager.locator("#freshnessNotice")).toHaveAttribute("data-state","uncertain");await expect(label(f.wid)).toContainText("Last known:");
  await network(manager,true);await expect(manager.locator("#freshnessNotice")).toHaveAttribute("data-state","server-confirmed");
  assert.equal((await state()).subscriptions,managerCount);
  await invoke("changeWindowState",[f.wid,f.shift,"pause"]);await expect(label(f.wid)).toContainText("Paused — not contributing");
  await invoke("changeWindowState",[f.wid,f.shift,"resume"]);await expect(label(f.wid)).toContainText("Window active");
  console.log("PASS IN_PROGRESS preservation, any-browser renewal, both closed exclusion, valid/expired reopen, manager local freshness, paused state and stable subscriptions");
  // Explicit human resolution/end enable replacement; connectivity does neither.
  await network(a,false);const current=(await state()).entries.find(e=>e.id==="assigned");
  await invoke("completeCustomer",[f.sid,"assigned",f.wid,f.shift,"manager",current.callAttemptId]);await invoke("changeWindowState",[f.wid,f.shift,"end"]);
  await expect(label(f.wid)).toContainText("Available — no active shift");
  const ended=await state();await a.close();a=await open();await expect(a.locator("#assignment")).toContainText("You don't have an active shift");await expect(a.locator("#presenceNotice")).toBeHidden();
  assert.deepEqual(await state(),ended);await a.close();
  const replacement=await manager.evaluate(async wid=>{const app=await import("/turncue.js"),code=await app.registerStaff("Replacement UX","staff"),p=await app.findStaff(code);return{code,staffId:p.id,shift:await app.startShift(p.id,wid)};},f.wid);
  const replaced=await state();a=await open();await expect(a.locator("#assignment")).toContainText("You don't have an active shift");assert.deepEqual(await state(),replaced);await a.close();
  b=await open(replacement.code);await connected(b);await expect(b.locator("#assignment")).toContainText("Presence UX");
  assert.equal((await state()).window.presenceStaffId,replacement.staffId);await b.close();
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log("PASS ended/reassigned reopen shows authoritative ownership, no old shift resurrection, replacement presence and no unexpected requests/errors");
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
