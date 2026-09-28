import fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
export const endpoint = "http://127.0.0.1:8787";
export function testProject(label) { return `demo-tc-${label}-${randomUUID().slice(0, 8)}`; }
export async function compileRules(project) {
  if (!/^demo-[a-z0-9-]+$/.test(project)) throw new Error("Only demo projects allowed");
  const content = fs.readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
  const response = await fetch(`${endpoint}/emulator/v1/projects/${project}:securityRules`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } })
  });
  const result = await response.json();
  if (!response.ok || result.issues?.some(issue => issue.severity === "ERROR")) throw new Error("Rules compilation failed: " + JSON.stringify(result));
  console.log(`PASS checkout rules compiled: ${project}; SHA256 ${createHash("sha256").update(content).digest("hex").slice(0, 12)}`);
}
