// Presence-only foundation. Owner REST writes backdate emulator fixtures, never
// production evidence. Without an observer, expiry does not write itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { startBrowserServer } from "./support/browser-server.mjs";
import { compileRules, testProject } from "./support/emulator.mjs";
const project = testProject("presence");
await compileRules(project);
const server = await startBrowserServer(project), origin = "http://127.0.0.1:" + server.address().port;
const emulator = "http://127.0.0.1:8787", errors = [], external = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if ([origin, emulator].includes(url.origin)) return route.continue();
    if (url.origin === "https://www.gstatic.com" && ["/firebasejs/12.19.0/firebase-app.js", "/firebasejs/12.19.0/firebase-firestore.js"].includes(url.pathname)) {
      let body = fs.readFileSync(path.join(process.env.TURNCUE_TEST_ASSETS, path.basename(url.pathname)), "utf8");
      if (url.pathname.endsWith("firebase-firestore.js")) {
        const start = body.lastIndexOf("export{"); assert(start >= 0);
        body = body.slice(0,start) + body.slice(start).replace(/([,{])onSnapshot(?=[,}])/, "$1onSnapshot as originalOnSnapshot")
          + "\nfunction countedSnapshot(...args) { globalThis.subscriptionStarts=(globalThis.subscriptionStarts||0)+1; return onSnapshot(...args); } export { countedSnapshot as onSnapshot };";
      }
      return route.fulfill({ body, contentType: "text/javascript" });
    }
    if (!(url.origin === "https://www.google.com" && url.pathname === "/images/cleardot.gif")) external.push(url.href);
    return route.abort();
  });
  const manager = await context.newPage(); manager.on("pageerror", e => errors.push(e.message));
  await manager.goto(origin + "/business.html");
  await expect(manager.locator("#sessionStatus")).toHaveText("Queue session ready");
  const f = await manager.evaluate(async () => {
    const app = await import("/turncue.js"), join = await import("/join-entry.js");
    const sid = await app.initializeTurnCue(), wid = await app.saveWindow(null,"Presence Test",true);
    const code = await app.registerStaff("Presence Staff","staff"), person = await app.findStaff(code), shift = await app.startShift(person.id,wid);
    await join.joinEntry(app.db,{businessId:app.BUSINESS_ID,locationId:app.LOCATION_ID,queueId:app.QUEUE_ID,sessionId:sid,entryId:"presence-ticket"});
    await app.callNext(wid,shift,sid);
    return {sid,wid,shift,staffId:person.id,code};
  });
  const state = () => manager.evaluate(async f => {
    const app=await import("/turncue.js"), sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    const read=async(...p)=>(await sdk.getDocFromServer(sdk.doc(app.db,...p))).data();
    const rows=async(...p)=>(await sdk.getDocsFromServer(sdk.collection(app.db,...p))).docs.map(d=>({id:d.id,...d.data()}));
    const window=await read("windows",f.wid);
    return JSON.parse(JSON.stringify({window,presence:app.windowPresenceState(window),ticket:await read("sessions",f.sid,"entries","presence-ticket"),
      shift:await read("shifts",f.shift),staff:await read("staff",f.staffId),events:await rows("windowEvents"),samples:await rows("queues",app.QUEUE_ID,"serviceSamples")}));
  },f);
  const fields=["presenceStaffId","presenceShiftId","lastPresenceAt","lastPresenceBrowserId","capacityExcludedAt"];
  const operational = value => { const copy=structuredClone(value); delete copy.presence; for(const key of fields) delete copy.window[key]; return copy; };
  const before=await state(); assert.equal(before.presence,"legacy");
  const invoke = (name,args) => manager.evaluate(async ({name,args}) => (await import("/turncue.js"))[name](...args),{name,args});
  const renew = id => invoke("renewWindowPresence",[f.wid,f.staffId,f.shift,id]);
  const exclude = () => invoke("excludeWindowCapacity",[f.wid,f.staffId,f.shift]);
  async function rejected(work) {
    const result=await manager.evaluate(async work => {
      const app=await import("/turncue.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
      try {
        if(work.fields) await sdk.updateDoc(sdk.doc(app.db,"windows",work.wid),Object.fromEntries(Object.entries(work.fields).map(([k,v])=>[k,v==="SERVER_TIMESTAMP"?sdk.serverTimestamp():v])));
        else await app[work.name](...work.args);
        return null;
      } catch(error) {return {code:error.code,message:error.message};}
    },work);
    assert(result,"Expected operation to be rejected"); return result;
  }
  async function age(milliseconds=300001) {
    const response=await fetch(`${emulator}/v1/projects/${project}/databases/(default)/documents/windows/${f.wid}?updateMask.fieldPaths=lastPresenceAt`,{
      method:"PATCH",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},
      body:JSON.stringify({fields:{lastPresenceAt:{timestampValue:new Date(Date.now()-milliseconds).toISOString()}}})});
    assert(response.ok,await response.text());
  }
  const denied = error => assert(["permission-denied","firestore/permission-denied"].includes(error.code),error.message);
  assert.equal(await exclude(),false); assert.deepEqual(await state(),before);
  await renew("browser-A"); let s=await state();
  assert.equal(s.presence,"valid"); assert(s.window.lastPresenceAt); assert.equal(s.window.presenceStaffId,f.staffId); assert.equal(s.window.presenceShiftId,f.shift);
  assert.deepEqual(operational(s),operational(before));
  denied(await rejected({name:"excludeWindowCapacity",args:[f.wid,f.staffId,f.shift]}));
  await renew("browser-B"); await renew("browser-B"); s=await state(); assert.equal(s.window.lastPresenceBrowserId,"browser-B");
  assert.equal(s.presence,"valid"); assert.deepEqual(operational(s),operational(before));
  console.log("PASS legacy semantics, initial server presence, two reporters, early expiry denied and lifecycle/inactivity preservation");
  await age(); assert.equal(await exclude(),true); s=await state(); assert.equal(s.presence,"excluded"); assert(s.window.capacityExcludedAt);
  assert.equal(await exclude(),false); assert.deepEqual(operational(s),operational(before));
  await renew("reopened-after-grace"); assert.equal((await state()).presence,"valid");
  await age(60000); await renew("reopened-within-grace"); assert.equal((await state()).window.capacityExcludedAt,null);
  // A stale observer captures evidence, then a competing renewal wins.
  await age(); const stale=(await state()).window.lastPresenceAt;
  await renew("race-winner");
  assert.equal(await manager.evaluate(async ({f,stale})=>{
    const app=await import("/turncue.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");
    return app.excludeWindowCapacity(f.wid,f.staffId,f.shift,new sdk.Timestamp(stale.seconds,stale.nanoseconds));
  },{f,stale}),false);
  await age(); await manager.evaluate(async f=>{
    const app=await import("/turncue.js"); await Promise.allSettled([app.excludeWindowCapacity(f.wid,f.staffId,f.shift),app.renewWindowPresence(f.wid,f.staffId,f.shift,"concurrent")]);
  },f);
  assert.equal((await state()).presence,"valid"); assert.deepEqual(operational(await state()),operational(before));
  for(const change of [
    {lastPresenceAt:"SERVER_TIMESTAMP",presenceStaffId:"wrong",presenceShiftId:f.shift,lastPresenceBrowserId:"bad",capacityExcludedAt:null},
    {lastPresenceAt:"SERVER_TIMESTAMP",presenceStaffId:f.staffId,presenceShiftId:f.shift,lastPresenceBrowserId:"bad",capacityExcludedAt:null,state:"paused"},
    {lastPresenceAt:"SERVER_TIMESTAMP",presenceStaffId:f.staffId,presenceShiftId:f.shift,lastPresenceBrowserId:"bad",capacityExcludedAt:null,updatedAt:"SERVER_TIMESTAMP"},
    {lastPresenceBrowserId:"tamper"}
  ]) denied(await rejected({wid:f.wid,fields:change}));
  console.log("PASS server expiry, before/after-grace renewal, stale/concurrent exclusion protection and metadata-only rules");
  await invoke("changeWindowState",[f.wid,f.shift,"pause"]); const paused=await state();
  await renew("paused-browser"); assert.deepEqual(operational(await state()),operational(paused)); assert.equal(await exclude(),false);
  await invoke("changeWindowState",[f.wid,f.shift,"resume"]);
  // Actual staff-page initialization, cadence, reconnect, visibility and reload.
  const staff=await context.newPage(); staff.on("pageerror",e=>errors.push(e.message)); await staff.clock.install();
  const login=async(page=staff)=>{
    await page.locator("#staffCode").fill(f.code); await page.locator("#entryForm button").click(); await page.locator("#confirmButton").click();
    await expect(page.locator("#freshnessNotice")).toHaveAttribute("data-state","server-confirmed");
  };
  await staff.goto(origin+"/staff.html"); await login();
  await expect.poll(async()=>(await state()).window.lastPresenceBrowserId).not.toBe("paused-browser");
  const id=(await state()).window.lastPresenceBrowserId, count=await staff.evaluate(()=>subscriptionStarts), baseline=operational(await state());
  let stamp=(await state()).window.lastPresenceAt;
  await staff.clock.fastForward(120000);
  await expect.poll(async()=>JSON.stringify((await state()).window.lastPresenceAt)).not.toBe(JSON.stringify(stamp));
  const network=enabled=>staff.evaluate(async enabled=>{
    const app=await import("/turncue.js"),sdk=await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js");await sdk[enabled?"enableNetwork":"disableNetwork"](app.db);
  },enabled);
  await network(false); await expect(staff.locator("#freshnessNotice")).toHaveAttribute("data-state","uncertain");
  const peer=await context.newPage(); peer.on("pageerror",e=>errors.push(e.message)); await peer.clock.install();
  await peer.goto(origin+"/staff.html"); await login(peer);
  await expect.poll(async()=>(await state()).window.lastPresenceBrowserId).not.toBe(id);
  const peerId=(await state()).window.lastPresenceBrowserId;
  stamp=(await state()).window.lastPresenceAt; await peer.clock.fastForward(120000);
  await expect.poll(async()=>JSON.stringify((await state()).window.lastPresenceAt)).not.toBe(JSON.stringify(stamp));
  assert.equal((await state()).window.lastPresenceBrowserId,peerId); assert.equal((await state()).presence,"valid");
  await peer.close();
  await age(); await exclude(); stamp=(await state()).window.lastPresenceAt;
  await network(true);
  await expect.poll(async()=>(await state()).presence).toBe("valid");
  assert.equal((await state()).window.lastPresenceBrowserId,id);
  stamp=(await state()).window.lastPresenceAt;
  await staff.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(async()=>JSON.stringify((await state()).window.lastPresenceAt)).not.toBe(JSON.stringify(stamp));
  assert.equal(await staff.evaluate(()=>subscriptionStarts),count); assert.deepEqual(operational(await state()),baseline);
  await staff.reload(); await login();
  await expect.poll(async()=>(await state()).window.lastPresenceBrowserId).not.toBe(id);
  await staff.close(); await age(); const closed=await state(); assert.equal(closed.window.capacityExcludedAt,null);
  await exclude(); assert.equal((await state()).presence,"excluded"); assert.deepEqual(operational(await state()),baseline);
  console.log("PASS paused ownership, staff initialization/cadence/reconnect/visibility/reload, fresh page identity, closed-browser expiry and no duplicate subscriptions");
  // End and replace only through existing explicit operations.
  const ticket=(await state()).ticket;
  await invoke("completeCustomer",[f.sid,"presence-ticket",f.wid,f.shift,"manager",ticket.callAttemptId]);
  await invoke("changeWindowState",[f.wid,f.shift,"end"]);
  const ended=await state(); assert(await rejected({name:"renewWindowPresence",args:[f.wid,f.staffId,f.shift,"old-browser"]})); assert.deepEqual(await state(),ended);
  const replacement=await manager.evaluate(async wid=>{const app=await import("/turncue.js");const code=await app.registerStaff("Replacement","staff"),p=await app.findStaff(code);return {staffId:p.id,shift:await app.startShift(p.id,wid)};},f.wid);
  const changed=await state(); assert.equal(changed.presence,"legacy");
  await rejected({name:"renewWindowPresence",args:[f.wid,f.staffId,f.shift,"old-reopened-browser"]}); assert.deepEqual(await state(),changed);
  await invoke("renewWindowPresence",[f.wid,replacement.staffId,replacement.shift,"new-browser"]);
  assert.equal((await state()).presence,"valid"); assert.deepEqual(operational(await state()),operational(changed));
  assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
  console.log("PASS ended/replaced ownership rejects old browsers, unenrolled new assignment ignores old evidence, new ownership renewal and no unexpected traffic/errors");
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
