// Intentional negative infrastructure checks. Run with tools installed, port 8787 free.
import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
function run(args, env = {}) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30000, windowsHide: true, env: { ...process.env, ...env } });
  assert(!result.error, result.error?.message);
  return { code: result.status, output: result.stdout + result.stderr };
}
const missing = run(["scripts/test.mjs", "rules"], { TURNCUE_TEST_JAVA: "turncue-intentionally-missing-java" });
assert.equal(missing.code, 2); assert.match(missing.output, /Java 21\+ unavailable/); assert(!missing.output.includes("RUN 1/"));
console.log("PASS unavailable Java/test setup exits 2 before tests");
const offline = run(["--import", "./tests/support/network-guard.mjs", "tests/rules.mjs"]);
assert.equal(offline.code, 1); assert.match(offline.output, /fetch failed/);
console.log("PASS unavailable emulator fails rules check; no fallback");
const busy = net.createServer();
await new Promise((resolve, reject) => { busy.once("error", reject); busy.listen(8787, "127.0.0.1", resolve); });
try {
  const occupied = run(["scripts/test.mjs", "rules"]);
  assert.equal(occupied.code, 2); assert.match(occupied.output, /Port 8787 is occupied/); assert(!occupied.output.includes("RUN 1/"));
  console.log("PASS occupied port rejected before any emulator reuse or test");
} finally { await new Promise(resolve => busy.close(resolve)); }
