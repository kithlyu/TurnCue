import { db, BUSINESS_ID, LOCATION_ID, QUEUE_ID } from "./firebase-client.js";
import { doc, collection, query, where, limit, getDocFromServer, getDocsFromServer } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { watchEntry } from "./turncue.js";
import { queueRank } from "./queue-fairness.js";
import { estimateWait, etaCopy } from "./eta.js";
import { serviceTiming, clockText } from "./service-workflow.js";
import { displayWindowLabel } from "./window-label.js";

// Read-only presentation in a trusted pilot, not an authorization boundary.
export function ticketLookupControls(host, context) {
  host.innerHTML = '<h2>Ticket lookup</h2><form><label>Ticket Number <input class="lookup-number" maxlength="120" autocomplete="off" autocapitalize="characters"></label><button type="submit">Search</button><button class="lookup-close secondary" type="button">Close Lookup</button></form><div class="lookup-result" role="status"></div><p class="notice">This lookup is view-only. Pilot access is not protected by authenticated role permissions.</p>';
  const form = host.querySelector("form"), input = host.querySelector("input"), search = form.querySelector('[type="submit"]'), result = host.querySelector(".lookup-result");
  let generation = 0, stop = null, timer = null, ticket = null, entryId = null, searching = false, scopeKey = "";
  const key = () => { const c = context(); return `${c.sessionId || ""}:${c.owner || "manager"}:${c.visible !== false}`; };
  function close() {
    generation++; stop?.(); stop = null; clearInterval(timer); timer = null;
    ticket = null; entryId = null; searching = false; result.replaceChildren();
  }
  host.querySelector(".lookup-close").onclick = () => { close(); render(); };
  function scoped(value, sessionId, label) {
    return value && value.businessId === BUSINESS_ID && value.locationId === LOCATION_ID
      && value.queueId === QUEUE_ID && value.sessionId === sessionId && value.ticketLabel === label;
  }
  function showTicket(value) {
    // Only these display inputs are retained; no credential/recovery fields.
    ticket = Object.fromEntries(["ticketLabel", "ticketNumber", "queueOrder", "status", "joinedAt", "calledAt", "completedAt", "confirmedPresentAt", "calledWindowLabel", "callAttemptId"].map(field => [field, value[field]]));
  }
  function line(text) { const p = document.createElement("p"); p.textContent = text; result.append(p); }
  function duration(start, end) {
    const a = start?.toMillis?.(), b = end?.toMillis?.();
    return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 60000)) + " min" : "—";
  }
  function render() {
    const c = context(), currentKey = key();
    if (scopeKey !== currentKey) { close(); scopeKey = currentKey; }
    host.hidden = c.visible === false;
    search.disabled = searching || !c.enabled || !c.sessionId;
    input.disabled = searching;
    if (!ticket) return;
    result.replaceChildren();
    line("Ticket: " + ticket.ticketLabel); line("Status: " + ticket.status.toUpperCase());
    if (ticket.status === "waiting") {
      const index = c.waiting.findIndex(e => e.id === entryId);
      if (index < 0 || queueRank(c.waiting[index]) !== queueRank(ticket)) { line("Position updating..."); return; }
      line("Position: #" + (index + 1)); line("People ahead: " + index);
      const copy = etaCopy(estimateWait({ samples: c.samples, windows: c.windows, waitingEntries: c.waiting, entryId }));
      line(copy.title + " · " + copy.detail);
    } else if (["called", "in_progress"].includes(ticket.status)) {
      line(ticket.calledWindowLabel ? "Window: " + displayWindowLabel(ticket.calledWindowLabel) : "Window not assigned (legacy call)");
      const timing = serviceTiming(ticket, ticket.callAttemptId ?? null);
      line(ticket.status === "in_progress" ? "Customer confirmed present · Service in progress"
        : timing.arrivalDecision ? "Arrival decision pending" : timing.active ? "Arrival window: " + clockText(timing.remainingSeconds) : "Call timing unavailable");
      if (timing.active) line("Service time: " + clockText(timing.elapsedSeconds));
    } else if (ticket.status === "completed") {
      line("Wait time: " + duration(ticket.joinedAt, ticket.calledAt));
      line("Service time: " + duration(ticket.calledAt, ticket.completedAt));
      line("Total time: " + duration(ticket.joinedAt, ticket.completedAt));
    }
  }
  form.onsubmit = async event => {
    event.preventDefault();
    if (search.disabled || searching) return;
    close(); scopeKey = key();
    const token = generation, lookupKey = scopeKey, label = input.value.trim().toUpperCase();
    searching = true; result.textContent = "Searching..."; render();
    const current = () => generation === token && key() === lookupKey;
    try {
      const queueRef = doc(db, "queues", QUEUE_ID);
      const queue = await getDocFromServer(queueRef), sessionId = queue.data()?.currentSessionId;
      if (!current()) return;
      if (!sessionId || sessionId !== context().sessionId || !label) { result.textContent = "Ticket not found in the current session."; return; }
      const matches = await getDocsFromServer(query(collection(db, "sessions", sessionId, "entries"), where("ticketLabel", "==", label), limit(2)));
      const latest = await getDocFromServer(queueRef);
      if (!current()) return;
      if (latest.data()?.currentSessionId !== sessionId) { result.textContent = "Session changed. Search again."; return; }
      if (matches.size !== 1 || !scoped(matches.docs[0]?.data(), sessionId, label)) {
        result.textContent = matches.size > 1 ? "Multiple matching tickets. Lookup unavailable." : "Ticket not found in the current session."; return;
      }
      entryId = matches.docs[0].id; showTicket(matches.docs[0].data());
      stop = watchEntry(sessionId, entryId, value => {
        if (!current()) return;
        if (!scoped(value, sessionId, label)) { close(); result.textContent = "Ticket no longer available."; render(); return; }
        showTicket(value); render();
      }, () => { if (current()) { close(); result.textContent = "Could not refresh ticket. Search again."; render(); } });
      timer = setInterval(render, 1000);
      render();
    } catch (_) { if (current()) result.textContent = "Could not read ticket. Please try again."; }
    finally { if (current()) { searching = false; render(); } }
  };
  render(); return render;
}
