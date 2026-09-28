// Preloaded by the maintained runner, including pure checks.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const rest = /^\/(?:v1|emulator\/v1)\/projects\/demo-[a-z0-9-]+(?:\/|:)/.test(url.pathname);
  const stream = /^\/google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel$/.test(url.pathname)
    && /^projects\/demo-[a-z0-9-]+\/databases\/\(default\)$/.test(url.searchParams.get("database") || "");
  if (url.origin !== "http://127.0.0.1:8787" || !(rest || stream)) {
    throw new Error("TEST NETWORK BLOCKED: " + url.href);
  }
  return realFetch(input, options);
};
