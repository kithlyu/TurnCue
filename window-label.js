// Presentation only: never use the formatted label in stored data.
export function displayWindowLabel(label) {
  const text = String(label ?? "").trim();
  return /^window(?:\s|$)/i.test(text) ? text : text ? "Window " + text : "Window";
}
