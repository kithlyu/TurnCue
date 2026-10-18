import { db, BUSINESS_ID, LOCATION_ID, QUEUE_ID } from "./firebase-client.js";
import { createAssistedRequest, issueAssistedEntry } from "./join-entry.js";

// UI separation only: pilot rules do not authenticate staff or hide codes.
export function assistedTicketControls(host, context) {
  host.innerHTML = '<h2>Issue a customer ticket</h2><p class="assisted-session muted"></p><button class="assisted-issue" type="button">ISSUE TICKET</button><p class="assisted-result" role="status"></p><p class="notice">Give the customer their ticket number and code to keep for later recovery. Pilot codes are not secure authentication credentials.</p>';
  const button = host.querySelector("button"), result = host.querySelector(".assisted-result");
  let request = null, busy = false, issued = false;
  function render() {
    const state = context();
    host.hidden = state.visible === false;
    host.querySelector(".assisted-session").textContent = "Queue: " + QUEUE_ID + " · Session: " + (request?.sessionId || state.sessionId || "unavailable");
    button.disabled = busy || !state.enabled || (!request && !state.sessionId);
    button.textContent = busy ? "ISSUING..." : request ? "RETRY ISSUANCE" : issued ? "ISSUE ANOTHER TICKET" : "ISSUE TICKET";
  }
  button.onclick = async () => {
    if (button.disabled || busy) return;
    request ||= createAssistedRequest({ businessId: BUSINESS_ID, locationId: LOCATION_ID, queueId: QUEUE_ID, sessionId: context().sessionId });
    busy = true; result.textContent = "Issuing ticket..."; render();
    try {
      const ticket = await issueAssistedEntry(db, request);
      result.textContent = "Ticket: " + ticket.ticketLabel + " · Recovery code: " + ticket.recoveryCode + ". Ask the customer to keep this code.";
      request = null; issued = true;
    } catch (error) { result.textContent = (error.message || "Could not issue ticket.") + " Retry uses the same issuance request."; }
    finally { busy = false; render(); }
  };
  render();
  return render;
}
