// Ticket creation and the +1 counter update remain one atomic transaction.
// Firestore handles transaction contention; permission errors surface normally.
import {
  doc, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

export function createAssistedRequest(scope) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Object.freeze({ ...scope, entryId: crypto.randomUUID(), recoveryCode: [...bytes].map(value => alphabet[value % 32]).join("") });
}

export async function issueAssistedEntry(db, request) {
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(request.recoveryCode || "")) throw new Error("Invalid recovery code.");
  const ticketLabel = await joinEntry(db, request);
  return { entryId: request.entryId, sessionId: request.sessionId, ticketLabel, recoveryCode: request.recoveryCode };
}

export async function joinEntry(db, { businessId, locationId, queueId, sessionId, entryId, recoveryCode }) {
  const sessionRef = doc(db, "sessions", sessionId);
  // SDK retries reuse this one entry ID.
  const entryRef = doc(db, "sessions", sessionId, "entries", entryId);
  const matches = entry => entry.businessId === businessId && entry.locationId === locationId
    && entry.queueId === queueId && entry.sessionId === sessionId;
  return runTransaction(db, async transaction => {
    const sessionSnapshot = await transaction.get(sessionRef);
    const existingEntry = await transaction.get(entryRef);
    if (existingEntry.exists()) {
      if (!matches(existingEntry.data())) throw new Error("Entry ID is already in use.");
      if (recoveryCode !== undefined && existingEntry.data().recoveryCode !== recoveryCode) throw new Error("Issuance identity is already in use.");
      return existingEntry.data().ticketLabel;
    }
    if (!sessionSnapshot.exists()) throw new Error("Queue session does not exist.");
    const sessionData = sessionSnapshot.data();
    if (sessionData.status !== "open") throw new Error("This queue is not open.");
    const queue = await transaction.get(doc(db, "queues", queueId));
    if (!queue.exists() || queue.data().currentSessionId !== sessionId) throw new Error("The current queue session has changed.");
    const nextTicketNumber = sessionData.nextTicketNumber;
    if (!Number.isSafeInteger(nextTicketNumber)) throw new Error("Invalid queue ticket counter.");
    const ticketLabel = (sessionData.ticketPrefix || "A") + nextTicketNumber;
    transaction.set(entryRef, {
      businessId, locationId, queueId, sessionId, ticketNumber: nextTicketNumber,
      ticketLabel, status: "waiting", joinedAt: serverTimestamp(),
      calledAt: null, completedAt: null, cancelledAt: null,
      ...(recoveryCode === undefined ? {} : { recoveryCode })
    });
    transaction.update(sessionRef, { nextTicketNumber: nextTicketNumber + 1 });
    return ticketLabel;
  });
}
