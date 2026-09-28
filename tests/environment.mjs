// No real SDK or network: exercise the boundary with SDK spies.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { resolveEnvironment, recoveryKeys, migrateProductionRecovery } from "../environment.js";

const production = resolveEnvironment({ hostname: "kithlyu.github.io" });
const local = resolveEnvironment({ hostname: "localhost" });
for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
  assert.deepEqual(resolveEnvironment({ hostname }), local);
}
for (const hostname of ["example.com", "192.168.1.2", "kithlyu.github.io.evil.test", ""]) {
  assert.throws(() => resolveEnvironment({ hostname }), /blocked/);
}
assert.equal(local.firebaseConfig.projectId, "demo-turncue-local");
assert.equal(production.emulator, null);
assert.deepEqual([production.businessId, production.locationId, production.queueId], ["demo-business", "main-location", "main-queue"]);
assert.deepEqual([local.businessId, local.locationId, local.queueId], [production.businessId, production.locationId, production.queueId]);
// Frozen Batch 3 public web config; works in shallow checkouts without Git history.
const oldConfig = JSON.parse(fs.readFileSync(new URL("./fixtures/production-config.json", import.meta.url), "utf8"));
assert.deepEqual(production.firebaseConfig, oldConfig);

const data = new Map([["turncue_active_entry", '{"sessionId":"old","entryId":"ticket"}'], ["turncue_get_ready", "old:ticket"]]);
const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
const localKeys = recoveryKeys(local), prodKeys = recoveryKeys(production);
assert.notEqual(localKeys.entry, prodKeys.entry);
assert.notEqual(localKeys.cue, prodKeys.cue);
migrateProductionRecovery(storage, local);
assert.equal(storage.getItem(localKeys.entry), null);
assert(storage.getItem("turncue_active_entry"));
migrateProductionRecovery(storage, production);
assert.equal(JSON.parse(storage.getItem(prodKeys.entry)).entryId, "ticket");
assert.equal(storage.getItem(prodKeys.cue), "old:ticket");
assert.equal(storage.getItem("turncue_active_entry"), null);
storage.setItem("turncue_active_entry", "stale");
migrateProductionRecovery(storage, production);
assert.equal(JSON.parse(storage.getItem(prodKeys.entry)).entryId, "ticket");

async function boot(hostname, available = true) {
  const calls = [], banners = [];
  const context = vm.createContext({
    location: { hostname }, AbortSignal,
    document: { createElement: () => ({ setAttribute() {}, style: {} }), body: { prepend: node => banners.push(node.textContent) } },
    fetch: async url => { calls.push(["fetch", url]); if (!available) throw new Error("offline"); return { ok: false, status: 404 }; }
  });
  const sdkApp = new vm.SyntheticModule(["initializeApp"], function () { this.setExport("initializeApp", config => { calls.push(["initialize", config]); return {}; }); }, { context });
  const sdkDb = new vm.SyntheticModule(["getFirestore", "connectFirestoreEmulator"], function () {
    this.setExport("getFirestore", () => ({}));
    this.setExport("connectFirestoreEmulator", (db, host, port) => calls.push(["connect", host, port]));
  }, { context });
  const environment = new vm.SourceTextModule(fs.readFileSync(new URL("../environment.js", import.meta.url), "utf8"), { context });
  const client = new vm.SourceTextModule(fs.readFileSync(new URL("../firebase-client.js", import.meta.url), "utf8"), { context });
  await client.link(id => id === "./environment.js" ? environment : id.endsWith("firebase-app.js") ? sdkApp : sdkDb);
  let error;
  try { await client.evaluate(); } catch (e) { error = e; }
  return { calls, banners, error };
}
for (const hostname of ["localhost", "127.0.0.1"]) {
  const result = await boot(hostname);
  assert(!result.error);
  assert.deepEqual(result.calls.map(c => c[0]), ["initialize", "connect", "fetch"]);
  assert.equal(result.calls[0][1].projectId, local.firebaseConfig.projectId);
  assert(result.calls[2][1].startsWith("http://127.0.0.1:8787/"));
  const offline = await boot(hostname, false);
  assert.match(offline.error.message, /Production fallback is disabled/);
  assert.match(offline.banners[0], /emulator unavailable/);
  assert.equal(offline.calls.filter(c => c[0] === "initialize").length, 1);
}
const prod = await boot("kithlyu.github.io", false);
assert(!prod.error);
assert.deepEqual(prod.calls.map(c => c[0]), ["initialize"]);
assert.equal(prod.calls[0][1].projectId, "turncue-83e1a");
const unknown = await boot("other.test");
assert(unknown.error);
assert.equal(unknown.calls.length, 0);
console.log("PASS environment selection, released production config, fail-closed boot, emulator-before-I/O, scoped recovery and legacy production recovery; zero network calls");
