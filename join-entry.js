// Ticket creation and the +1 counter update remain one atomic transaction.
// Firestore handles transaction contention; permission errors surface normally.
import {
  doc, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

export async function joinEntry(db, { businessId, locationId, queueId, sessionId, entryId }) {
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
      return existingEntry.data().ticketLabel;
    }
    if (!sessionSnapshot.exists()) throw new Error("Queue session does not exist.");
    const sessionData = sessionSnapshot.data();
    if (sessionData.status !== "open") throw new Error("This queue is not open.");
    const nextTicketNumber = sessionData.nextTicketNumber;
    if (!Number.isSafeInteger(nextTicketNumber)) throw new Error("Invalid queue ticket counter.");
    const ticketLabel = (sessionData.ticketPrefix || "A") + nextTicketNumber;
    transaction.set(entryRef, {
      businessId, locationId, queueId, sessionId, ticketNumber: nextTicketNumber,
      ticketLabel, status: "waiting", joinedAt: serverTimestamp(),
      calledAt: null, completedAt: null, cancelledAt: null
    });
    transaction.update(sessionRef, { nextTicketNumber: nextTicketNumber + 1 });
    return ticketLabel;
  });
}
