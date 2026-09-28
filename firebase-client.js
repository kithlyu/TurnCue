import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { resolveEnvironment } from "./environment.js";

function showEnvironmentError(error) {
  if (!globalThis.document) return;
  const banner = document.createElement("div");
  banner.id = "environmentError";
  banner.setAttribute("role", "alert");
  banner.style.cssText = "padding:20px;background:#fff0f0;color:#8b0000;border:2px solid #8b0000;position:relative;z-index:10000";
  banner.textContent = error.message;
  document.body.prepend(banner);
}

let environment, db;
try {
  environment = resolveEnvironment(globalThis.location);
  db = getFirestore(initializeApp(environment.firebaseConfig));
  if (environment.emulator) {
    const { host, port } = environment.emulator;
    // Connect before any read/listener/write. There is no production fallback.
    connectFirestoreEmulator(db, host, port);
    try {
      const response = await fetch(`http://${host}:${port}/v1/projects/${environment.firebaseConfig.projectId}/databases/(default)/documents/queues/${environment.queueId}`, {
        signal: AbortSignal.timeout(4000), cache: "no-store"
      });
      // A fresh emulator has no queue yet; the manager initializes it normally.
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
    } catch (cause) {
      throw new Error(`TurnCue local development: Firestore emulator unavailable at ${host}:${port}. Start the local workflow, then reload. Production fallback is disabled.`, { cause });
    }
  }
} catch (error) {
  showEnvironmentError(error);
  throw error;
}

export { db, environment };
export const BUSINESS_ID = environment.businessId;
export const LOCATION_ID = environment.locationId;
export const QUEUE_ID = environment.queueId;
