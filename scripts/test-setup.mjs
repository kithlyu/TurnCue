// Downloads tools only. Test commands themselves never download anything.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { root, toolsDir, tooling, verifiedAsset } from "./test-tooling.mjs";
try {
  fs.mkdirSync(toolsDir, { recursive: true });
  for (const asset of tooling.assets) {
    try { verifiedAsset(asset); console.log("READY " + asset.file); continue; } catch {}
    console.log("DOWNLOAD " + asset.url);
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("Checksum mismatch: " + asset.file);
    fs.writeFileSync(path.join(toolsDir, asset.file), bytes);
  }
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/playwright/cli.js"), "install", "chromium"], {
    stdio: "inherit", windowsHide: true,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(toolsDir, "browsers") }
  });
  if (result.error || result.status !== 0) throw new Error("Chromium setup failed; run npm ci first. " + (result.error?.message || ""));
  console.log("READY pinned test assets and Chromium. Java 21+ must be installed separately.");
} catch (error) { console.error("SETUP FAILED: " + error.message); process.exitCode = 2; }
