// No SDK imports: environment selection is also safe to inspect in Node tests.
const productionConfig = Object.freeze({
  apiKey: "AIzaSyCngq4CXYVHXBqr_zipMgIqPiDWxzlpIVM",
  authDomain: "turncue-83e1a.firebaseapp.com",
  projectId: "turncue-83e1a",
  storageBucket: "turncue-83e1a.firebasestorage.app",
  messagingSenderId: "459437201769",
  appId: "1:459437201769:web:1859490f3db0f3fc2945f8"
});
const scope = Object.freeze({ businessId: "demo-business", locationId: "main-location", queueId: "main-queue" });

export function resolveEnvironment(location) {
  const hostname = location?.hostname?.toLowerCase();
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
  if (!local && hostname !== "kithlyu.github.io") {
    throw new Error("TurnCue environment blocked. Use http://localhost:8080 for local development or the published GitHub Pages site.");
  }
  const firebaseConfig = local
    ? Object.freeze({ projectId: "demo-turncue-local", apiKey: "demo-only", appId: "demo-turncue-local" })
    : productionConfig;
  return Object.freeze({
    mode: local ? "local" : "production", firebaseConfig, ...scope,
    emulator: local ? Object.freeze({ host: "127.0.0.1", port: 8787 }) : null,
    storagePrefix: `turncue:${firebaseConfig.projectId}:${scope.businessId}:${scope.locationId}:${scope.queueId}`
  });
}

export function recoveryKeys(environment) {
  return { entry: `${environment.storagePrefix}:active_entry`, cue: `${environment.storagePrefix}:get_ready` };
}

// Preserve released same-device tickets. Never import old localhost production keys.
export function migrateProductionRecovery(storage, environment) {
  if (environment.mode !== "production") return;
  const keys = recoveryKeys(environment);
  for (const [oldKey, key] of [["turncue_active_entry", keys.entry], ["turncue_get_ready", keys.cue]]) {
    const oldValue = storage.getItem(oldKey);
    if (oldValue !== null) {
      if (storage.getItem(key) === null) storage.setItem(key, oldValue);
      storage.removeItem(oldKey);
    }
  }
}
