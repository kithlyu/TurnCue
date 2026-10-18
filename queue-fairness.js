import { estimateWait } from "./eta.js";

// Ticket numbers are allocated serially by JOIN. Missing ranks retain that FIFO.
export const queueRank = entry => entry.queueOrder ?? entry.ticketNumber;
export function compareWaiting(a, b) {
  return queueRank(a) - queueRank(b) || a.ticketNumber - b.ticketNumber || a.id.localeCompare(b.id);
}

export function fairnessPosition({ customer, waiting, windows, samples, nextTicketNumber, now = Date.now() }) {
  const others = waiting.filter(e => e.id !== customer.id).sort(compareWaiting);
  const original = customer.status === "waiting" ? [...others, customer].sort(compareWaiting) : [customer, ...others];
  const originalIndex = original.findIndex(e => e.id === customer.id);
  const capacity = windows.filter(w => w.currentStaffId && w.currentShiftId);
  const estimate = entries => estimateWait({ samples, windows: capacity, waitingEntries: entries, entryId: customer.id, now });
  const baseline = estimate(original);
  if (!Number.isFinite(baseline.minutes) || !Number.isFinite(baseline.paceMinutes)) {
    const error = new Error("Need More Time is unavailable until service estimates are available.");
    error.code = "eta-unavailable";
    throw error;
  }
  const targetMinutes = Math.max(10, baseline.paceMinutes);
  let position = others.length, additionalMinutes = 0;
  for (let i = Math.min(originalIndex + 1, others.length); i <= others.length; i++) {
    const proposed = others.slice(); proposed.splice(i, 0, customer);
    additionalMinutes = Math.max(0, estimate(proposed).minutes - baseline.minutes);
    position = i;
    if (additionalMinutes >= targetMinutes) break;
  }
  const lower = position ? queueRank(others[position - 1]) : null;
  const upper = position < others.length ? queueRank(others[position]) : nextTicketNumber;
  let queueOrder = lower === null ? Math.min(queueRank(customer), upper - 1) : (lower + upper) / 2;
  if (customer.status === "waiting") queueOrder = Math.max(queueRank(customer), queueOrder);
  if (!Number.isFinite(queueOrder) || (lower !== null && queueOrder <= lower) || queueOrder >= upper) {
    throw new Error("Queue positions are too close to reposition safely. No change was made.");
  }
  return { queueOrder, position, targetMinutes, additionalMinutes };
}
