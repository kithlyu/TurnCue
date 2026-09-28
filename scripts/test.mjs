import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { root, toolsDir, outputDir, tooling, verifiedAsset } from "./test-tooling.mjs";

const fast = ["eta", "eta-hardening", "inactivity", "inactivity-ui", "bulk-setup", "staff-import", "environment", "network-guard"];
const integration = ["window-operations", "retired-windows", "window-label-immutability", "window-label-uniqueness"];
const browser = ["environment-browser", "batch3-browser"];
const concurrency = ["concurrency join", "concurrency call", "inactivity-release --concurrent-only"];
const groups = {
  fast, rules: ["rules"], browser, concurrency, integration,
  release: [...fast, "rules", ...integration, ...browser, "concurrency join", "concurrency call", "inactivity-release"]
};
const group = process.argv[2] || "fast";
const selected = process.argv[3] ? groups[group]?.filter(test => test === process.argv[3]) : groups[group];
let emulator, activeTest, log, logPath;
let stopping = false;

async function stop(child, tree = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  if (tree && process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10000 });
  } else if (tree) {
    process.kill(-child.pid, "SIGTERM");
  } else child.kill();
  await closed;
}
async function cleanup() {
  await stop(activeTest, true);
  await stop(emulator);
  log?.end();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await cleanup();
  process.exit(signal === "SIGINT" ? 130 : 143);
});
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", () => reject(new Error("Port 8787 is occupied. Stop the local development emulator first; tests never reuse it."))); probe.listen(8787, "127.0.0.1", resolve); });
  await new Promise(resolve => probe.close(resolve));
}
async function prepare() {
  for (const asset of tooling.assets) verifiedAsset(asset);
  const java = process.env.TURNCUE_TEST_JAVA || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : "java");
  const version = spawnSync(java, ["-version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const major = Number(((version.stderr || "") + (version.stdout || "")).match(/version "(\d+)/)?.[1]);
  if (version.error || version.status !== 0 || major < 21 || !major) throw new Error("Java 21+ unavailable. Set JAVA_HOME or TURNCUE_TEST_JAVA to a Java executable.");
  if (groups[group].some(test => browser.includes(test))) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(toolsDir, "browsers");
    const { chromium } = await import("playwright");
    if (!fs.existsSync(chromium.executablePath())) throw new Error("Pinned Chromium unavailable. Run npm run test:setup.");
  }
  await freePort();
  fs.mkdirSync(outputDir, { recursive: true });
  logPath = path.join(outputDir, `emulator-${group}-${Date.now()}.log`);
  log = fs.createWriteStream(logPath);
  emulator = spawn(java, ["-jar", verifiedAsset(tooling.assets[0]), "--host", "127.0.0.1", "--port", "8787", "--rules", path.join(root, "firestore.rules"), "--project_id", "demo-turncue-runner"], {
    cwd: outputDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  let startError;
  emulator.on("error", error => { startError = error; });
  emulator.stdout.pipe(log, { end: false }); emulator.stderr.pipe(log, { end: false });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (startError || emulator.exitCode !== null) throw new Error("Emulator startup failed. " + (startError?.message || "See " + logPath));
    const ready = await new Promise(resolve => {
      const socket = net.createConnection({ host: "127.0.0.1", port: 8787 });
      socket.setTimeout(500);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (ready) { console.log("READY owned loopback emulator; no cloud credentials or .firebaserc used"); return; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("Emulator startup timed out. See " + logPath);
}

try {
  if (!groups[group]) throw new Error("Unknown checkpoint. Use: " + Object.keys(groups).join(", "));
  if (!selected.length) throw new Error("Unknown focused test in " + group);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 22 && minor >= 7) || major === 24)) throw new Error("Use Node 22.7+ (22.x) or 24.x.");
  if (group !== "fast") await prepare();
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [index, test] of selected.entries()) {
    const [file, ...args] = test.split(" ");
    console.log(`\nRUN ${index + 1}/${selected.length} ${test}`);
    const testLogPath = path.join(outputDir, `${group}-${Date.now()}-${file}.log`);
    const testLog = fs.createWriteStream(testLogPath);
    let stderr = "";
    activeTest = spawn(process.execPath, ["--experimental-vm-modules", "--import", "./tests/support/network-guard.mjs", `tests/${file}.mjs`, ...args], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
      env: { ...process.env, TURNCUE_TEST_ASSETS: toolsDir, TURNCUE_TEST_BROWSER: "", PLAYWRIGHT_BROWSERS_PATH: path.join(toolsDir, "browsers") }
    });
    activeTest.stdout.on("data", chunk => { process.stdout.write(chunk); testLog.write(chunk); });
    activeTest.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); testLog.write(chunk); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void stop(activeTest, true); }, file === "inactivity-release" ? 210000 : 90000);
    const [code, signal] = await once(activeTest, "close");
    clearTimeout(timer); activeTest = null; testLog.end();
    if (code !== 0) {
      if (stderr) console.error(stderr);
      console.error("Full test log: " + testLogPath);
      console.error(`STOP ${test}: ${timedOut ? "timeout" : `exit ${code}, signal ${signal || "none"}`}. No later tests ran.`);
      process.exitCode = 1;
      break;
    }
  }
  if (!process.exitCode) console.log(`\nPASS ${group} checkpoint`);
} catch (error) {
  console.error("SETUP FAILED (no fallback): " + error.message);
  process.exitCode = 2;
} finally {
  await cleanup();
  if (logPath) console.log("Emulator stopped; isolated in-memory test data discarded. Log: " + logPath);
}
