import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const requests = [];
const context = vm.createContext({ URL, fetch: async url => { requests.push(url); return { ok: true }; } });
const guard = new vm.SourceTextModule(fs.readFileSync(new URL("./support/network-guard.mjs", import.meta.url), "utf8"), { context });
await guard.link(() => { throw new Error("Unexpected import"); });
await guard.evaluate();
for (const url of [
  "http://127.0.0.1:8787/v1/projects/demo-test/databases/(default)/documents:commit",
  "http://127.0.0.1:8787/emulator/v1/projects/demo-test:securityRules",
  "http://127.0.0.1:8787/google.firestore.v1.Firestore/Listen/channel?database=projects%2Fdemo-test%2Fdatabases%2F(default)"
]) await context.fetch(url);
assert.equal(requests.length, 3);
for (const url of [
  "https://firestore.googleapis.com/v1/projects/demo-test/databases/(default)/documents",
  "http://127.0.0.1:8787/v1/projects/turncue-83e1a/databases/(default)/documents",
  "http://127.0.0.1:8787/google.firestore.v1.Firestore/Listen/channel?database=projects%2Fturncue-83e1a%2Fdatabases%2F(default)",
  "http://127.0.0.1:8787/google.firestore.v1.Firestore/Listen/channel",
  "http://example.com/v1/projects/demo-test/databases/(default)/documents"
]) assert.throws(() => context.fetch(url), /TEST NETWORK BLOCKED/);
assert.equal(requests.length, 3);
console.log("PASS test network guard: demo REST and streaming allowed; cloud/non-demo blocked before fetch");
