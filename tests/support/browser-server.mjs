import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const files = new Set(["index.html", "business.html", "staff.html", "turncue.js", "turncue.css", "environment.js", "firebase-client.js", "join-entry.js", "eta.js", "inactivity.js", "bulk-setup.js", "staff-import.js", "window-label.js", "window-operations.js"]);
export async function startBrowserServer(project) {
  if (!/^demo-[a-z0-9-]+$/.test(project)) throw new Error("Only demo projects allowed");
  const server = http.createServer((request, response) => {
    const file = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
    if (file === "favicon.ico") { response.writeHead(204).end(); return; }
    if (!files.has(file)) { response.writeHead(404).end(); return; }
    let content = fs.readFileSync(path.join(root, file), "utf8");
    if (file === "environment.js") content = content.replaceAll("demo-turncue-local", project);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    response.end(content);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}
