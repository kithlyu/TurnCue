export function generateWindowLabels(mode, quantity, windows = []) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 26) throw new Error("Quantity must be a whole number from 1 to 26.");
  if (!["numbered", "letters"].includes(mode)) throw new Error("Choose Numbered or Lettered.");
  let highest = 0;
  for (const window of windows) {
    const key = normalizeWindowLabel(window.name);
    const match = key.match(mode === "numbered" ? /^window ([1-9]\d*)$/ : /^window ([a-z])$/);
    if (match) highest = Math.max(highest, mode === "numbered" ? Number(match[1]) : match[1].charCodeAt(0) - 96);
  }
  // Continue after the highest label, including disabled windows; never fill gaps.
  if (mode === "letters" && highest + quantity > 26) throw new Error("Lettered windows stop at Z. Only " + (26 - highest) + " additional lettered windows are available.");
  if (mode === "numbered" && !Number.isSafeInteger(highest + quantity)) throw new Error("The next window number exceeds the supported numeric limit.");
  return Array.from({ length: quantity }, (_, i) => "Window " + (mode === "numbered" ? highest + i + 1 : String.fromCharCode(65 + highest + i)));
}
// Identity comparison only; never replace a window's stored name with this key.
export const normalizeWindowLabel = label => "window " + String(label).trim().replace(/^window\s+/i, "").trim().toLowerCase();
export function labelConflicts(labels, windows) {
  const existing = new Set(windows.map(window => normalizeWindowLabel(window.name)));
  return labels.filter(label => existing.has(normalizeWindowLabel(label)));
}
