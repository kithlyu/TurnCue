import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const toolsDir = path.join(root, ".test-tools");
export const outputDir = path.join(root, ".test-output");
export const tooling = JSON.parse(fs.readFileSync(path.join(root, "tests/tooling.json"), "utf8"));
export function verifiedAsset(asset) {
  const file = path.join(toolsDir, asset.file);
  if (!fs.existsSync(file) || createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== asset.sha256) {
    throw new Error(`Missing or mismatched ${asset.file}. Run npm run test:setup.`);
  }
  return file;
}
