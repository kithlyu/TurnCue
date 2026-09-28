// Uses an already-running loopback emulator; never reads the live project alias.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnvironment } from "../environment.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environment = resolveEnvironment({ hostname: "localhost" });
const { host, port } = environment.emulator;
const files = new Set(["index.html", "business.html", "staff.html", "turncue.js", "turncue.css", "environment.js", "firebase-client.js", "join-entry.js", "eta.js", "inactivity.js", "bulk-setup.js", "staff-import.js", "window-label.js", "window-operations.js"]);

export async function startLocalServer(portNumber = 8080) {
  const response = await fetch(`http://${host}:${port}/emulator/v1/projects/${environment.firebaseConfig.projectId}:securityRules`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content: fs.readFileSync(path.join(root, "firestore.rules"), "utf8") }] } })
  });
  const result = await response.json();
  if (!response.ok || result.issues?.some(issue => issue.severity === "ERROR")) {
    throw new Error("Local rules compilation failed: " + JSON.stringify(result));
  }
  const server = http.createServer((request, response) => {
    const file = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
    if (!files.has(file)) { response.writeHead(404).end(); return; }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    response.end(fs.readFileSync(path.join(root, file)));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(portNumber, host, resolve); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await startLocalServer();
    console.log("Current checkout rules compiled. Local-only project: " + environment.firebaseConfig.projectId);
    console.log("Customer: http://127.0.0.1:8080/\nManager: http://127.0.0.1:8080/business.html\nStaff: http://127.0.0.1:8080/staff.html");
    console.log("Open Manager first to initialize local data. Ctrl+C stops the web server.");
  } catch (error) {
    console.error("Local development stopped. Start the Firestore emulator on 127.0.0.1:8787, then retry. No production fallback.", error.message);
    process.exitCode = 1;
  }
}
