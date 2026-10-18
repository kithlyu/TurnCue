// Shared Batch 2 operations. Staff ID confirmation is NOT authentication.
import { db, BUSINESS_ID, LOCATION_ID, QUEUE_ID } from "./firebase-client.js";
export { db, BUSINESS_ID, LOCATION_ID, QUEUE_ID } from "./firebase-client.js";
import {
  doc, collection, getDoc, getDocFromServer, getDocsFromServer, query, where,
  orderBy, limit, startAfter, onSnapshot, runTransaction, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { isInactivityDue, pendingCheckDecision } from "./inactivity.js";
import { normalizeWindowLabel } from "./bulk-setup.js";
import { compareWaiting, queueRank, fairnessPosition } from "./queue-fairness.js";
import { serviceTiming } from "./service-workflow.js";
import { windowPresenceState } from "./eta.js";
export { windowPresenceState } from "./eta.js";

const scope = { businessId: BUSINESS_ID, locationId: LOCATION_ID, queueId: QUEUE_ID };
const ref = (name, id) => doc(db, name, id);
const newRef = name => doc(collection(db, name));
const entryRef = (sessionId, entryId) => doc(db, "sessions", sessionId, "entries", entryId);
const sampleRef = entryId => doc(db, "queues", QUEUE_ID, "serviceSamples", entryId);
const clearInactivity = { inactivityCheckState: null, inactivityCheckId: null, inactivityCheckStartedAt: null, inactivityCheckDeadline: null };

function fail(message, code = "operation-blocked") {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function data(snapshot, message) {
  if (!snapshot.exists()) fail(message);
  return snapshot.data();
}
function cleanName(value) {
  const name = value.trim();
  if (!name || name.length > 80) fail("Enter a name of 1 to 80 characters.");
  return name;
}
function inScope(value) {
  return value.businessId === BUSINESS_ID && value.locationId === LOCATION_ID && value.queueId === QUEUE_ID;
}

export async function initializeTurnCue() {
  // Read everything before writing; concurrent dashboard opens share one session.
  const nextSessionRef = newRef("sessions");
  return runTransaction(db, async tx => {
    const businessRef = ref("businesses", BUSINESS_ID);
    const locationRef = ref("locations", LOCATION_ID);
    const queueRef = ref("queues", QUEUE_ID);
    const business = await tx.get(businessRef);
    const location = await tx.get(locationRef);
    const queue = await tx.get(queueRef);
    const existingId = queue.exists() ? queue.data().currentSessionId : null;
    const existing = existingId ? await tx.get(ref("sessions", existingId)) : null;
    const sessionId = existing?.exists() && existing.data().status === "open" ? existingId : nextSessionRef.id;
    if (!business.exists()) tx.set(businessRef, { name: "TurnCue Demo Business", active: true, createdAt: serverTimestamp() });
    if (!location.exists()) tx.set(locationRef, { businessId: BUSINESS_ID, name: "Main Location", active: true, createdAt: serverTimestamp() });
    if (sessionId === nextSessionRef.id) {
      tx.set(nextSessionRef, { ...scope, status: "open", ticketPrefix: "A", nextTicketNumber: 101, openedAt: serverTimestamp(), closedAt: null });
    }
    if (!queue.exists()) {
      tx.set(queueRef, { businessId: BUSINESS_ID, locationId: LOCATION_ID, name: "Main Queue", active: true, currentSessionId: sessionId, ticketPrefix: "A", ticketStart: 101, createdAt: serverTimestamp() });
    } else if (sessionId !== existingId) {
      tx.update(queueRef, { currentSessionId: sessionId });
    }
    return sessionId;
  });
}

export async function registerStaff(name, role) {
  name = cleanName(name);
  if (!["staff", "manager"].includes(role)) fail("Choose Staff or Manager.");
  // A separate immutable lookup reserves the visible ID atomically. Never reuse it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const staffRef = newRef("staff");
    const staffCode = "TC-" + staffRef.id.slice(0, 8).toUpperCase();
    const codeRef = ref("staffCodes", staffCode);
    const created = await runTransaction(db, async tx => {
      if ((await tx.get(codeRef)).exists()) return false;
      tx.set(staffRef, { businessId: BUSINESS_ID, staffCode, name, role, active: true, currentShiftId: null, currentWindowId: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      tx.set(codeRef, { businessId: BUSINESS_ID, staffId: staffRef.id, createdAt: serverTimestamp() });
      return true;
    });
    if (created) return staffCode;
  }
  fail("Couldn't generate a Staff ID. Please try again.");
}

export async function findStaff(staffCode) {
  const code = staffCode.trim().toUpperCase();
  if (!/^TC-[A-Z0-9]{8}$/.test(code)) fail("Enter a Staff ID such as TC-AB12CD34.");
  const lookup = data(await getDoc(ref("staffCodes", code)), "Staff ID not found.");
  const snapshot = await getDoc(ref("staff", lookup.staffId));
  const person = data(snapshot, "Staff record not found.");
  if (person.businessId !== BUSINESS_ID || !person.active) fail("This staff record is inactive or unavailable. Please ask the manager.");
  return { id: snapshot.id, ...person };
}

export async function setStaffActive(staffId, active) {
  return runTransaction(db, async tx => {
    const staffRef = ref("staff", staffId);
    const person = data(await tx.get(staffRef), "Staff record not found.");
    if (person.businessId !== BUSINESS_ID) fail("Staff belongs to another business.");
    if (person.currentShiftId) fail("End this staff member's shift before changing their active status.");
    tx.update(staffRef, { active, updatedAt: serverTimestamp() });
  });
}

async function rejectExistingWindowLabel(name) {
  // Legacy immutable windows may predate reservations. Check server data, including
  // disabled windows, in bounded pages. Concurrent new creates share a reservation.
  const key = normalizeWindowLabel(name);
  let cursor = null;
  for (;;) {
    const constraints = [where("queueId", "==", QUEUE_ID), limit(100)];
    if (cursor) constraints.push(startAfter(cursor));
    const page = await getDocsFromServer(query(collection(db, "windows"), ...constraints));
    if (page.docs.some(snapshot => inScope(snapshot.data()) && normalizeWindowLabel(snapshot.data().name) === key)) fail("Already exists: " + name);
    if (page.size < 100) return;
    cursor = page.docs[page.docs.length - 1];
  }
}

export async function saveWindow(windowId, name, active) {
  name = cleanName(name);
  if (!windowId) await rejectExistingWindowLabel(name);
  const windowRef = windowId ? ref("windows", windowId) : newRef("windows");
  const labelRef = ref("windowLabels", normalizeWindowLabel(name));
  const configurationEventRef = newRef("windowEvents");
  return runTransaction(db, async tx => {
    const snapshot = await tx.get(windowRef);
    if (snapshot.exists()) {
      const window = snapshot.data();
      if (!inScope(window)) fail("Window belongs to another queue.");
      if (window.retired === true) fail("This window is retired and cannot be changed.");
      if (window.currentEntryId || window.currentSessionId) fail("Complete the assigned customer before changing this window.");
      if (window.currentShiftId || window.currentStaffId || ["active", "paused"].includes(window.state)) fail("End the shift before changing this window.");
      if (name !== window.name) fail("Window labels are permanent for beta and cannot be renamed.");
      if (window.active === active) {
        tx.update(windowRef, { updatedAt: serverTimestamp() });
      } else {
        const state = active ? "available" : "inactive";
        tx.update(windowRef, {
          active, state, stateChangedAt: serverTimestamp(), updatedAt: serverTimestamp(),
          lastEventId: configurationEventRef.id
        });
        recordEvent(tx, configurationEventRef, windowRef.id, null, null,
          active ? "window_enabled" : "window_disabled", window.state, state, "manager");
      }
    } else {
      if (windowId) fail("Window no longer exists.");
      if ((await tx.get(labelRef)).exists()) fail("Already exists: " + name);
      tx.set(windowRef, { ...scope, name, active, state: active ? "available" : "inactive", currentStaffId: null, currentShiftId: null, currentEntryId: null, currentSessionId: null, currentTicketLabel: null, lastEventId: null, lastActionAt: null, stateChangedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      tx.set(labelRef, { ...scope, windowId: windowRef.id, createdAt: serverTimestamp() });
    }
    return windowRef.id;
  });
}

export async function bulkCreateWindows(labels) {
  const results = [];
  for (const label of labels) {
    const name = cleanName(label);
    try { await saveWindow(null, name, true); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: error.message }); }
  }
  return results;
}

function recordEvent(tx, eventRef, windowId, staffId, shiftId, type, fromState, toState, source, details = {}) {
  tx.set(eventRef, { ...scope, windowId, staffId, shiftId, type, fromState, toState, source, occurredAt: serverTimestamp(), ...details });
}

export async function startShift(staffId, windowId) {
  if (!windowId) fail("Choose an available window first.");
  const shiftRef = newRef("shifts");
  const eventRef = newRef("windowEvents");
  return runTransaction(db, async tx => {
    const staffRef = ref("staff", staffId), windowRef = ref("windows", windowId);
    const person = data(await tx.get(staffRef), "Staff record not found.");
    const window = data(await tx.get(windowRef), "Window no longer exists.");
    if (!person.active || person.businessId !== BUSINESS_ID) fail("Staff record is inactive or unavailable.");
    if (person.currentShiftId || person.currentWindowId) fail("You already have a shift. Your current window will appear shortly.");
    if (window.retired === true || !inScope(window) || !window.active || window.state !== "available" || window.currentShiftId || window.currentStaffId || window.currentEntryId) fail("This window is no longer available. Please choose another window.");
    tx.set(shiftRef, { ...scope, staffId, windowId, state: "active", startedAt: serverTimestamp(), endedAt: null, currentEntryId: null, currentSessionId: null, lastActionAt: serverTimestamp() });
    tx.update(staffRef, { currentShiftId: shiftRef.id, currentWindowId: windowId, updatedAt: serverTimestamp() });
    tx.update(windowRef, { state: "active", currentStaffId: staffId, currentShiftId: shiftRef.id, lastActionAt: serverTimestamp(), stateChangedAt: serverTimestamp(), updatedAt: serverTimestamp(), lastEventId: eventRef.id, ...clearInactivity, pauseSource: null, reviewFlagType: null, reviewFlagAt: null });
    recordEvent(tx, eventRef, windowId, staffId, shiftRef.id, "shift_started", window.state, "active", "staff");
    return shiftRef.id;
  });
}

async function readAssignment(tx, windowId, expectedShiftId) {
  const windowRef = ref("windows", windowId);
  const window = data(await tx.get(windowRef), "Window not found.");
  if (window.retired === true || !inScope(window) || !window.active || !expectedShiftId || window.currentShiftId !== expectedShiftId || !window.currentStaffId) fail("This assignment has changed. Check the current window and try again.");
  const staffRef = ref("staff", window.currentStaffId), shiftRef = ref("shifts", expectedShiftId);
  const person = data(await tx.get(staffRef), "Staff record not found.");
  const shift = data(await tx.get(shiftRef), "Shift not found.");
  if (!person.active || person.businessId !== BUSINESS_ID || person.currentShiftId !== expectedShiftId || person.currentWindowId !== windowId || !inScope(shift) || shift.staffId !== window.currentStaffId || shift.windowId !== windowId || shift.endedAt !== null || shift.state !== window.state || !["active", "paused"].includes(window.state) || shift.currentEntryId !== window.currentEntryId || shift.currentSessionId !== window.currentSessionId) fail("The assignment is no longer current. Refresh and check with the manager.");
  return { window, person, shift, windowRef, staffRef, shiftRef };
}

export async function changeWindowState(windowId, expectedShiftId, action, source = "staff") {
  if (!["pause", "resume", "end"].includes(action)) fail("Unknown window action.");
  const eventRef = newRef("windowEvents");
  return runTransaction(db, async tx => {
    const a = await readAssignment(tx, windowId, expectedShiftId);
    const { window } = a;
    if (action === "end" && window.currentEntryId) fail("Complete the called customer before ending this shift.");
    if (action === "pause" && window.state !== "active") fail("Window is already paused.");
    if (action === "resume" && window.state !== "paused") fail("Window is already active.");
    const state = action === "end" ? "available" : action === "pause" ? "paused" : "active";
    const windowChange = { state, stateChangedAt: serverTimestamp(), lastActionAt: serverTimestamp(), updatedAt: serverTimestamp(), lastEventId: eventRef.id, ...clearInactivity,
      pauseSource: action === "pause" ? "manual" : null, ...(action === "resume" ? { reviewFlagType: null, reviewFlagAt: null } : {}) };
    const shiftChange = { state: action === "end" ? "ended" : state, lastActionAt: serverTimestamp() };
    if (action === "end") {
      Object.assign(windowChange, { currentShiftId: null, currentStaffId: null });
      shiftChange.endedAt = serverTimestamp();
      tx.update(a.staffRef, { currentShiftId: null, currentWindowId: null, updatedAt: serverTimestamp() });
    }
    tx.update(a.windowRef, windowChange);
    tx.update(a.shiftRef, shiftChange);
    if (action === "pause" && window.currentEntryId) {
      tx.update(entryRef(window.currentSessionId, window.currentEntryId), { etaLearningEligible: false, etaExclusionReason: "paused_during_service" });
    }
    recordEvent(tx, eventRef, windowId, window.currentStaffId, expectedShiftId, action === "end" ? "shift_ended" : action === "pause" ? "window_paused" : "window_resumed", window.state, state, source);
  });
}

// Merge ranked tickets with legacy/default FIFO tickets. Read default tickets in
// small pages so a moved ticket cannot hide the next untouched ticket.
async function waitingCandidates(sessionId) {
  const entries = collection(db, "sessions", sessionId, "entries");
  const moved = await getDocsFromServer(query(entries, where("status", "==", "waiting"), orderBy("queueOrder", "asc"), orderBy("ticketNumber", "asc"), limit(1)));
  let cursor = null, ordinary = null;
  do {
    const page = await getDocsFromServer(query(entries, where("status", "==", "waiting"), orderBy("ticketNumber", "asc"), ...(cursor ? [startAfter(cursor)] : []), limit(16)));
    ordinary = page.docs.find(d => d.data().queueOrder == null);
    if (ordinary || page.size < 16) break;
    cursor = page.docs.at(-1);
  } while (true);
  const docs = [...moved.docs, ...(ordinary ? [ordinary] : [])];
  docs.sort((a, b) => compareWaiting({ id: a.id, ...a.data() }, { id: b.id, ...b.data() }));
  return { docs, empty: docs.length === 0 };
}

export async function callNext(windowId, expectedShiftId, sessionId, source = "staff") {
  if (!sessionId) fail("There is no open session.");
  // The web SDK cannot transactionally query a collection. Fetch the earliest
  // candidate from the SERVER, then read and verify it inside the transaction.
  // Losing a candidate race causes a fresh query, never a successful no-op.
  for (let attempt = 0; attempt < 12; attempt++) {
    const before = data(await getDocFromServer(ref("sessions", sessionId)), "Session no longer exists.");
    const candidates = await waitingCandidates(sessionId);
    if (candidates.empty) return null;
    const candidateRef = candidates.docs[0].ref;
    const eventRef = newRef("windowEvents");
    try {
      return await runTransaction(db, async tx => {
        const a = await readAssignment(tx, windowId, expectedShiftId);
        const customer = data(await tx.get(candidateRef), "Customer no longer exists.");
        const session = data(await tx.get(ref("sessions", sessionId)), "Session no longer exists.");
        const queue = data(await tx.get(ref("queues", QUEUE_ID)), "Queue no longer exists.");
        if ((session.queueRevision || 0) !== (before.queueRevision || 0) || session.nextTicketNumber !== before.nextTicketNumber) fail("Queue order changed.", "candidate-lost");
        if (a.window.state !== "active") fail("Resume this window before calling next.");
        if (a.window.currentEntryId || a.shift.currentEntryId) fail("Complete the current customer before calling next.");
        if (!inScope(session) || session.status !== "open" || queue.currentSessionId !== sessionId) fail("The operational session has changed. Wait for the dashboard to refresh.");
        if (customer.status !== "waiting") fail("Another window called this customer.", "candidate-lost");
        if (!inScope(customer) || customer.sessionId !== sessionId) fail("Customer belongs to another queue.");
        tx.update(ref("sessions", sessionId), { queueRevision: (session.queueRevision || 0) + 1 });
        tx.update(candidateRef, { status: "called", callAttemptId: eventRef.id, calledAt: serverTimestamp(), confirmedPresentAt: null, calledByStaffId: a.window.currentStaffId, calledByShiftId: expectedShiftId, calledWindowId: windowId, calledWindowLabel: a.window.name, etaLearningEligible: true });
        tx.update(a.windowRef, { currentEntryId: candidateRef.id, currentSessionId: sessionId, currentTicketLabel: customer.ticketLabel, currentCallAttemptId: eventRef.id, currentEntryCalledAt: serverTimestamp(), lastActionAt: serverTimestamp(), updatedAt: serverTimestamp(), lastEventId: eventRef.id, ...clearInactivity });
        tx.update(a.shiftRef, { currentEntryId: candidateRef.id, currentSessionId: sessionId, lastActionAt: serverTimestamp() });
        recordEvent(tx, eventRef, windowId, a.window.currentStaffId, expectedShiftId, "customer_called", "active", "active", source, { entryId: candidateRef.id, sessionId });
        return customer.ticketLabel;
      });
    } catch (error) {
      // A rules evaluation can see a competing call before the SDK reports a
      // version conflict. Retry a denied call ONLY after a server read proves
      // that this candidate has left waiting; other permission errors surface.
      if (["permission-denied", "firestore/permission-denied"].includes(error.code)) {
        const latest = await getDocFromServer(candidateRef);
        if (latest.exists() && latest.data().status !== "waiting") continue;
        const currentSession = await getDocFromServer(ref("sessions", sessionId));
        if (currentSession.exists() && ((currentSession.data().queueRevision || 0) !== (before.queueRevision || 0) || currentSession.data().nextTicketNumber !== before.nextTicketNumber)) continue;
      }
      if (!["candidate-lost", "aborted", "firestore/aborted"].includes(error.code)) throw error;
    }
  }
  fail("The queue is changing quickly. No new call was confirmed. Check your window and try again.");
}

// Queries discover documents; transaction reads verify them. The session read /
// revision write fences JOIN, CALL, leave and reposition membership changes.
async function fairnessInputs(tx, sessionId, session, customer, releasingWindowId = null) {
  const [waiting, windows, samples] = await Promise.all([
    getDocsFromServer(query(collection(db, "sessions", sessionId, "entries"), where("status", "==", "waiting"))),
    getDocsFromServer(query(collection(db, "windows"), where("queueId", "==", QUEUE_ID))),
    getDocsFromServer(query(collection(db, "queues", QUEUE_ID, "serviceSamples"), orderBy("recordedAt", "desc"), limit(40)))
  ]);
  const rows = await Promise.all(waiting.docs.map(d => tx.get(d.ref)));
  const resources = await Promise.all(windows.docs.map(d => tx.get(d.ref)));
  return { customer, nextTicketNumber: session.nextTicketNumber,
    waiting: rows.filter(d => d.exists() && d.data().status === "waiting").map(d => ({ id: d.id, ...d.data() })),
    windows: resources.filter(d => d.exists() && inScope(d.data())).map(d => ({ id: d.id, ...d.data(), ...(d.id === releasingWindowId ? { currentEntryId: null, currentEntryCalledAt: null } : {}) })),
    samples: samples.docs.map(d => d.data()).reverse() };
}

const proposalRef = (sessionId, customerId, proposalId) => doc(entryRef(sessionId, customerId), "proposals", proposalId);
export async function requestNeedMoreTime(sessionId, customerId) {
  const proposal = doc(collection(entryRef(sessionId, customerId), "proposals"));
  const preview = await runTransaction(db, async tx => {
    const session = data(await tx.get(ref("sessions", sessionId)), "Session not found.");
    const customer = { ...data(await tx.get(entryRef(sessionId, customerId)), "Customer not found."), id: customerId };
    if (!inScope(customer) || customer.sessionId !== sessionId || customer.status !== "waiting" || customer.customerNeedMoreTimeAt != null) fail("Need More Time is not available for this ticket.");
    const position = fairnessPosition(await fairnessInputs(tx, sessionId, session, customer));
    tx.set(proposal, { status: "pending", createdAt: serverTimestamp(), ...position });
    return position;
  });
  const saved = data(await getDocFromServer(proposal), "Proposal not found.");
  return { proposalId: proposal.id, ...preview, expiresAt: saved.createdAt.toMillis() + 20000 };
}

export async function cancelNeedMoreTime(sessionId, customerId, proposalId) {
  const proposal = proposalRef(sessionId, customerId, proposalId);
  return runTransaction(db, async tx => {
    const saved = data(await tx.get(proposal), "Proposal not found.");
    if (saved.status !== "pending") fail("Proposal is no longer pending.");
    tx.update(proposal, { status: "cancelled" });
  });
}

export function confirmNeedMoreTime(sessionId, customerId, proposalId) {
  return transitionTicket(sessionId, customerId, "need_more_time", null, null, "customer", null, proposalId);
}

export async function transitionTicket(sessionId, customerId, action, windowId = null, expectedShiftId = null, source = "staff", expectedCallAttemptId = null, proposalId = null) {
  const actions = ["confirm_present", "no_show", "opted_out", "left_queue", "need_more_time", "staff_need_more_time", "service_interrupted"];
  if (!actions.includes(action)) fail("Unknown ticket action.");
  const customerRef = entryRef(sessionId, customerId);
  const eventRef = doc(collection(customerRef, "events"));
  return runTransaction(db, async tx => {
    const changesOrder = ["left_queue", "need_more_time", "staff_need_more_time", "service_interrupted"].includes(action);
    const session = changesOrder ? data(await tx.get(ref("sessions", sessionId)), "Session not found.") : null;
    const customer = data(await tx.get(customerRef), "Customer not found.");
    if (!inScope(customer) || customer.sessionId !== sessionId) fail("Customer belongs to another queue.");
    const waitingAction = ["left_queue", "need_more_time"].includes(action);
    const allowed = waitingAction ? ["waiting"] : ["confirm_present", "no_show"].includes(action) ? ["called"] : ["called", "in_progress"];
    if (!allowed.includes(customer.status)) fail("This ticket action is no longer available.");
    if (!waitingAction) validateCallAttempt(customer, expectedCallAttemptId);
    const usageField = action === "need_more_time" ? "customerNeedMoreTimeAt" : action === "staff_need_more_time" ? "staffNeedMoreTimeAt" : null;
    if (usageField && customer[usageField] != null) fail("This Need More Time allowance has already been used.");
    let a = null;
    if (!waitingAction && customer.calledWindowId) {
      a = await readAssignment(tx, windowId, expectedShiftId);
      if (customer.calledWindowId !== windowId || customer.calledByShiftId !== expectedShiftId || customer.calledByStaffId !== a.window.currentStaffId || a.window.currentEntryId !== customerId || a.window.currentSessionId !== sessionId) fail("This customer is not assigned to this shift.");
    } else if (!waitingAction && source !== "manager") fail("Ask the manager to resolve this earlier call.");
    let proposal = null, reposition = null;
    if (action === "need_more_time") {
      if (!proposalId) fail("Request and confirm a Need More Time proposal first.");
      proposal = proposalRef(sessionId, customerId, proposalId);
      const saved = data(await tx.get(proposal), "Proposal not found.");
      if (saved.status !== "pending" || Date.now() >= saved.createdAt.toMillis() + 20000) fail("Proposal expired or is no longer pending.");
    }
    if (["need_more_time", "staff_need_more_time"].includes(action)) {
      reposition = fairnessPosition(await fairnessInputs(tx, sessionId, session, { ...customer, id: customerId }, a?.windowRef.id));
    } else if (action === "service_interrupted") {
      const waiting = await getDocsFromServer(query(collection(db, "sessions", sessionId, "entries"), where("status", "==", "waiting")));
      reposition = { queueOrder: Math.min(customer.ticketNumber, ...waiting.docs.map(d => queueRank(d.data()))) - 1 };
    }
    const status = action === "confirm_present" ? "in_progress" : ["need_more_time", "staff_need_more_time", "service_interrupted"].includes(action) ? "waiting" : action;
    const timestampField = { confirm_present: "confirmedPresentAt", no_show: "noShowAt", opted_out: "optedOutAt", left_queue: "leftQueueAt", service_interrupted: "serviceInterruptedAt" }[action] || usageField;
    if (changesOrder) tx.update(ref("sessions", sessionId), { queueRevision: (session.queueRevision || 0) + 1 });
    if (proposal) tx.update(proposal, { status: "confirmed" });
    tx.update(customerRef, { status, [timestampField]: serverTimestamp(), ...(reposition ? { queueOrder: reposition.queueOrder } : {}), ...(!waitingAction && status === "waiting" ? { callAttemptId: null } : {}) });
    tx.set(eventRef, { type: action, fromStatus: customer.status, toStatus: status, occurredAt: serverTimestamp(),
      callAttemptId: customer.callAttemptId || null, calledAt: customer.calledAt || null, windowId: customer.calledWindowId || null,
      staffId: customer.calledByStaffId || null, shiftId: customer.calledByShiftId || null });
    if (a && action !== "confirm_present") {
      tx.update(a.windowRef, { currentEntryId: null, currentSessionId: null, currentTicketLabel: null, currentEntryCalledAt: null, currentCallAttemptId: null, lastActionAt: serverTimestamp(), updatedAt: serverTimestamp(), ...clearInactivity });
      tx.update(a.shiftRef, { currentEntryId: null, currentSessionId: null, lastActionAt: serverTimestamp() });
    }
    return reposition;
  });
}

function validateCallAttempt(customer, expectedCallAttemptId) {
  // Never substitute the freshly read attempt for the caller's captured token.
  // Missing tokens remain compatible only with pre-attempt legacy records.
  if ((customer.callAttemptId ?? null) !== expectedCallAttemptId) fail("This call attempt is no longer current.", "stale-call-attempt");
}

function recordServiceSample(tx, customer, sessionId, customerId, windowId, shiftId) {
  const cleanEligible = customer.etaLearningEligible === true && Boolean(customer.calledAt?.toMillis?.());
  // Deterministic ID and original server timestamps preserve existing consumers.
  tx.set(sampleRef(customerId), { ...scope, sessionId, entryId: customerId, windowId, shiftId,
    calledAt: customer.calledAt || null, completedAt: serverTimestamp(), durationSeconds: null, durationMinutes: null,
    cleanEligible, exclusionReason: cleanEligible ? null : (customer.etaExclusionReason || "invalid_or_legacy_service"), recordedAt: serverTimestamp() });
}

// The current outcome, history/sample, next assignment and window state commit
// together. There is no resolve-then-call gap and no deferred automatic call.
export async function resolveAndContinue(sessionId, customerId, windowId, expectedShiftId, expectedCallAttemptId, outcome, after, source = "staff") {
  if (!["completed", "no_show"].includes(outcome) || !["next", "pause"].includes(after)) fail("Unknown service action.");
  const customerRef = entryRef(sessionId, customerId);
  for (let attempt = 0; attempt < 12; attempt++) {
    const before = after === "next" ? data(await getDocFromServer(ref("sessions", sessionId)), "Session not found.") : null;
    const candidates = after === "next" ? await waitingCandidates(sessionId) : { docs: [] };
    const nextRef = candidates.docs[0]?.ref || null;
    const resolutionEvent = newRef("windowEvents"), nextEvent = newRef("windowEvents"), stateEvent = newRef("windowEvents");
    const ticketEvent = doc(collection(customerRef, "events"));
    try {
      return await runTransaction(db, async tx => {
        const a = await readAssignment(tx, windowId, expectedShiftId);
        const customer = data(await tx.get(customerRef), "Customer not found.");
        if (!inScope(customer) || customer.sessionId !== sessionId || !["called", "in_progress"].includes(customer.status)) fail("This customer is no longer awaiting resolution.");
        validateCallAttempt(customer, expectedCallAttemptId);
        if (customer.calledWindowId !== windowId || customer.calledByShiftId !== expectedShiftId || customer.calledByStaffId !== a.window.currentStaffId || a.window.currentEntryId !== customerId || a.window.currentSessionId !== sessionId) fail("This customer is not assigned to this shift.");
        if (outcome === "no_show" && !serviceTiming(customer, expectedCallAttemptId).arrivalDecision) fail("The arrival decision is not available for this call.");
        let session = null, next = null;
        if (after === "next") {
          session = data(await tx.get(ref("sessions", sessionId)), "Session not found.");
          const queue = data(await tx.get(ref("queues", QUEUE_ID)), "Queue not found.");
          if (!inScope(session) || session.status !== "open" || queue.currentSessionId !== sessionId) fail("The operational session has changed.");
          if ((session.queueRevision || 0) !== (before.queueRevision || 0) || session.nextTicketNumber !== before.nextTicketNumber) fail("Queue order changed.", "candidate-lost");
          next = nextRef ? data(await tx.get(nextRef), "Next ticket not found.") : null;
          if (next && (next.status !== "waiting" || !inScope(next) || next.sessionId !== sessionId)) fail("Next ticket changed.", "candidate-lost");
        }
        const state = after === "pause" ? "paused" : "active";
        tx.update(customerRef, { status: outcome, [outcome === "completed" ? "completedAt" : "noShowAt"]: serverTimestamp() });
        if (outcome === "completed") recordServiceSample(tx, customer, sessionId, customerId, windowId, expectedShiftId);
        else tx.set(ticketEvent, { type: "no_show", fromStatus: customer.status, toStatus: "no_show", occurredAt: serverTimestamp(), callAttemptId: customer.callAttemptId || null, calledAt: customer.calledAt || null, windowId, staffId: a.window.currentStaffId, shiftId: expectedShiftId });
        recordEvent(tx, resolutionEvent, windowId, a.window.currentStaffId, expectedShiftId, outcome === "completed" ? "customer_completed" : "customer_no_show", a.window.state, a.window.state, source, { entryId: customerId, sessionId });
        if (next) {
          tx.update(ref("sessions", sessionId), { queueRevision: (session.queueRevision || 0) + 1 });
          tx.update(nextRef, { status: "called", callAttemptId: nextEvent.id, calledAt: serverTimestamp(), confirmedPresentAt: null, calledByStaffId: a.window.currentStaffId, calledByShiftId: expectedShiftId, calledWindowId: windowId, calledWindowLabel: a.window.name, etaLearningEligible: true });
          recordEvent(tx, nextEvent, windowId, a.window.currentStaffId, expectedShiftId, "customer_called", "active", "active", source, { entryId: nextRef.id, sessionId });
        }
        const changesState = state !== a.window.state;
        if (changesState) recordEvent(tx, stateEvent, windowId, a.window.currentStaffId, expectedShiftId, state === "paused" ? "window_paused" : "window_resumed", a.window.state, state, source);
        tx.update(a.windowRef, { state, ...(changesState ? { stateChangedAt: serverTimestamp() } : {}),
          currentEntryId: nextRef?.id || null, currentSessionId: next ? sessionId : null,
          currentTicketLabel: next?.ticketLabel || null, currentCallAttemptId: next ? nextEvent.id : null,
          currentEntryCalledAt: next ? serverTimestamp() : null, lastActionAt: serverTimestamp(), updatedAt: serverTimestamp(),
          lastEventId: next ? nextEvent.id : changesState ? stateEvent.id : resolutionEvent.id, ...clearInactivity,
          pauseSource: state === "active" ? null : changesState ? "manual" : (a.window.pauseSource || null),
          ...(state === "active" && changesState ? { reviewFlagType: null, reviewFlagAt: null } : {}) });
        tx.update(a.shiftRef, { state, currentEntryId: nextRef?.id || null, currentSessionId: next ? sessionId : null, lastActionAt: serverTimestamp() });
        return { outcome, state, nextTicketLabel: next?.ticketLabel || null };
      });
    } catch (error) {
      if (after === "next" && ["permission-denied", "firestore/permission-denied"].includes(error.code)) {
        const current = await getDocFromServer(ref("sessions", sessionId));
        if (current.exists() && ((current.data().queueRevision || 0) !== (before.queueRevision || 0) || current.data().nextTicketNumber !== before.nextTicketNumber)) continue;
      }
      if (!["candidate-lost", "aborted", "firestore/aborted"].includes(error.code)) throw error;
    }
  }
  fail("The queue is changing quickly. No service action was committed. Try again.");
}

export async function completeCustomer(sessionId, customerId, windowId = null, expectedShiftId = null, source = "staff", expectedCallAttemptId = null) {
  const eventRef = newRef("windowEvents");
  return runTransaction(db, async tx => {
    const customerRef = entryRef(sessionId, customerId);
    const customer = data(await tx.get(customerRef), "Customer not found.");
    if (!inScope(customer) || customer.sessionId !== sessionId || !["called", "in_progress"].includes(customer.status)) fail("This customer is no longer awaiting completion.");
    validateCallAttempt(customer, expectedCallAttemptId);
    if (!customer.calledWindowId) {
      // Historical Batch 1 calls have no window assignment to release.
      if (source !== "manager") fail("Ask the manager to complete this earlier call.");
      tx.update(customerRef, { status: "completed", completedAt: serverTimestamp() });
      return;
    }
    const a = await readAssignment(tx, windowId, expectedShiftId);
    if (customer.calledWindowId !== windowId || customer.calledByShiftId !== expectedShiftId || customer.calledByStaffId !== a.window.currentStaffId || a.window.currentEntryId !== customerId || a.window.currentSessionId !== sessionId) fail("This customer is not assigned to this shift.");
    tx.update(customerRef, { status: "completed", completedAt: serverTimestamp() });
    // Entry ID is deterministic: repeated completion cannot duplicate a sample.
    recordServiceSample(tx, customer, sessionId, customerId, windowId, expectedShiftId);
    tx.update(a.windowRef, { currentEntryId: null, currentSessionId: null, currentTicketLabel: null, currentEntryCalledAt: null, currentCallAttemptId: null, lastActionAt: serverTimestamp(), updatedAt: serverTimestamp(), lastEventId: eventRef.id, ...clearInactivity });
    tx.update(a.shiftRef, { currentEntryId: null, currentSessionId: null, lastActionAt: serverTimestamp() });
    recordEvent(tx, eventRef, windowId, a.window.currentStaffId, expectedShiftId, "customer_completed", a.window.state, a.window.state, source, { entryId: customerId, sessionId });
  });
}

async function firstWaitingCandidate(sessionId) {
  const candidates = await getDocsFromServer(query(collection(db, "sessions", sessionId, "entries"), where("status", "==", "waiting"), orderBy("joinedAt", "asc"), limit(1)));
  return candidates.empty ? null : candidates.docs[0].ref;
}

// Called by the future best-effort evaluator after it has calculated learnPace.
export async function startInactivityCheck(windowId, expectedShiftId, sessionId, learned, now = Date.now()) {
  const candidateRef = await firstWaitingCandidate(sessionId);
  if (!candidateRef) return null;
  const eventRef = newRef("windowEvents"), checkId = eventRef.id;
  return runTransaction(db, async tx => {
    const a = await readAssignment(tx, windowId, expectedShiftId);
    const candidate = data(await tx.get(candidateRef), "Waiting customer changed.");
    if (candidate.status !== "waiting" || !isInactivityDue(a.window, true, learned, now)) return null;
    tx.update(a.windowRef, { inactivityCheckState: "pending", inactivityCheckId: checkId,
      inactivityCheckStartedAt: serverTimestamp(), inactivityCheckDeadline: Timestamp.fromMillis(now + 120000), lastEventId: eventRef.id, updatedAt: serverTimestamp() });
    recordEvent(tx, eventRef, windowId, a.window.currentStaffId, expectedShiftId, "inactivity_check_started", "active", "active", "inactivity_check", { checkId });
    return checkId;
  });
}

export async function confirmInactivityCheck(windowId, expectedShiftId, checkId) {
  const eventRef = newRef("windowEvents");
  return runTransaction(db, async tx => {
    const a = await readAssignment(tx, windowId, expectedShiftId);
    if (a.window.inactivityCheckState !== "pending" || a.window.inactivityCheckId !== checkId || a.window.currentEntryId) fail("This inactivity check is no longer pending.");
    tx.update(a.windowRef, { ...clearInactivity, lastActionAt: serverTimestamp(), updatedAt: serverTimestamp(), lastEventId: eventRef.id });
    tx.update(a.shiftRef, { lastActionAt: serverTimestamp() });
    recordEvent(tx, eventRef, windowId, a.window.currentStaffId, expectedShiftId, "inactivity_check_confirmed", "active", "active", "inactivity_check", { checkId });
  });
}

export async function resolveExpiredInactivityCheck(windowId, expectedShiftId, sessionId, checkId, now = Date.now()) {
  const candidateRef = await firstWaitingCandidate(sessionId);
  const eventRef = newRef("windowEvents");
  return runTransaction(db, async tx => {
    const a = await readAssignment(tx, windowId, expectedShiftId);
    const hasWaiting = candidateRef ? (await tx.get(candidateRef)).data()?.status === "waiting" : false;
    if (a.window.inactivityCheckId !== checkId || pendingCheckDecision(a.window, hasWaiting, now) === "none") return null;
    if (pendingCheckDecision(a.window, hasWaiting, now) === "cancel") {
      tx.update(a.windowRef, { ...clearInactivity, lastEventId: eventRef.id, updatedAt: serverTimestamp() });
      recordEvent(tx, eventRef, windowId, a.window.currentStaffId, expectedShiftId, "inactivity_check_cancelled", "active", "active", "inactivity_check", { checkId, reason: "queue_empty" });
      return "cancelled";
    }
    tx.update(a.windowRef, { state: "paused", stateChangedAt: serverTimestamp(), lastActionAt: serverTimestamp(), updatedAt: serverTimestamp(), lastEventId: eventRef.id,
      ...clearInactivity, pauseSource: "inactivity_check", reviewFlagType: "inactivity_check", reviewFlagAt: serverTimestamp() });
    tx.update(a.shiftRef, { state: "paused", lastActionAt: serverTimestamp() });
    recordEvent(tx, eventRef, windowId, a.window.currentStaffId, expectedShiftId, "window_auto_paused", "active", "paused", "inactivity_check", { checkId });
    return "auto_paused";
  });
}

// Queue-empty cancellation is separate from expiry so pages can remove an
// unnecessary prompt immediately. The transaction makes concurrent tabs single-winner.
export async function cancelInactivityCheckIfQueueEmpty(windowId, expectedShiftId, sessionId, checkId) {
  if (await firstWaitingCandidate(sessionId)) return null;
  const eventRef = newRef("windowEvents");
  return runTransaction(db, async tx => {
    const a = await readAssignment(tx, windowId, expectedShiftId);
    if (a.window.inactivityCheckState !== "pending" || a.window.inactivityCheckId !== checkId || a.window.currentEntryId) return null;
    tx.update(a.windowRef, { ...clearInactivity, lastEventId: eventRef.id, updatedAt: serverTimestamp() });
    recordEvent(tx, eventRef, windowId, a.window.currentStaffId, expectedShiftId, "inactivity_check_cancelled", "active", "active", "inactivity_check", { checkId, reason: "queue_empty" });
    return "cancelled";
  });
}

// Equality-only setup queries use Firestore's automatic single-field indexes.
// Metadata is opt-in so existing customer/lookup consumers retain their callbacks.
function watchData(target, next, error, metadata) {
  return onSnapshot(target, { includeMetadataChanges: Boolean(metadata) }, snapshot => {
    metadata?.(snapshot.metadata); next(snapshot);
  }, failure => { metadata?.(null); error?.(failure); });
}
export function captureAction(action, window, ticket = null, sessionId = null, after = null) {
  return Object.freeze({ action, after, windowId: window?.id || ticket?.calledWindowId || null,
    shiftId: window?.currentShiftId || ticket?.calledByShiftId || null,
    staffId: window?.currentStaffId || ticket?.calledByStaffId || null,
    sessionId: ticket?.sessionId || sessionId || window?.currentSessionId || null,
    entryId: ticket?.id || null, callAttemptId: ticket?.callAttemptId ?? null,
    preStatus: ticket?.status || null, preWindowState: window?.state || null,
    staffNeedMoreTimeAt: ticket?.staffNeedMoreTimeAt?.toMillis?.() ?? null,
    queueOrder: ticket?.queueOrder ?? null, windowEntryId: window?.currentEntryId ?? null,
    windowCallAttemptId: window?.currentCallAttemptId ?? null, windowSessionId: window?.currentSessionId ?? null });
}

export async function reconcileAction(context) {
  // Separate reads are not an atomic snapshot. Check pointer coherence, then
  // re-read every observed document; operational changes leave this unresolved.
  // confirm_present is recognized only when that write alone lands between the
  // two reads. staff_need_more_time defers only its exact mixed first-pass
  // pointer failure until the second reads prove that committed action.
  // The mutation is never replayed.
  const observed = new Map();
  function signature(target, value) {
    if (target.parent.path === "windows" && value != null) {
      value = { ...value };
      delete value.lastPresenceAt;
      delete value.lastPresenceBrowserId;
    }
    return JSON.stringify(value);
  }
  async function read(target, optional = false) {
    if (observed.has(target.path)) return observed.get(target.path).value;
    const snapshot = await getDocFromServer(target);
    if (!snapshot.exists() && !optional) fail("Current state is unavailable.");
    const value = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
    observed.set(target.path, { target, value, signature: signature(target, snapshot.data() ?? null) });
    return value;
  }
  let original = context.entryId ? await read(entryRef(context.sessionId, context.entryId)) : null;
  if (original && (!inScope(original) || original.sessionId !== context.sessionId)) fail("Ticket scope changed.");
  let window = context.windowId ? await read(ref("windows", context.windowId)) : null;
  let oldShift = context.shiftId ? await read(ref("shifts", context.shiftId)) : null;
  const person = context.staffId ? await read(ref("staff", context.staffId)) : null;
  const queue = await read(ref("queues", QUEUE_ID));
  const session = context.sessionId ? await read(ref("sessions", context.sessionId)) : null;
  if (session && !inScope(session)) fail("Session scope changed.");
  if (queue.businessId !== BUSINESS_ID || queue.locationId !== LOCATION_ID || window && !inScope(window) || oldShift && (!inScope(oldShift) || oldShift.windowId !== context.windowId || oldShift.staffId !== context.staffId) || person && person.businessId !== BUSINESS_ID) fail("Assignment scope changed.");
  let currentShift = null, currentPerson = null, assigned = null;
  if (window?.currentShiftId) {
    currentShift = await read(ref("shifts", window.currentShiftId));
    currentPerson = await read(ref("staff", window.currentStaffId));
    if (!inScope(currentShift) || currentPerson.businessId !== BUSINESS_ID || currentShift.endedAt !== null
      || currentShift.windowId !== window.id || currentShift.staffId !== window.currentStaffId || currentShift.state !== window.state
      || currentPerson.currentShiftId !== currentShift.id || currentPerson.currentWindowId !== window.id
      || currentShift.currentEntryId !== window.currentEntryId || currentShift.currentSessionId !== window.currentSessionId) fail("Assignment snapshots disagree.");
  } else if (window && (window.currentStaffId || window.currentEntryId || window.currentSessionId)) fail("Assignment snapshots disagree.");
  if (oldShift && oldShift.endedAt === null && window.currentShiftId !== oldShift.id) fail("Shift snapshots disagree.");
  if (oldShift?.endedAt && person?.currentShiftId === oldShift.id) fail("Staff snapshots disagree.");
  if (window?.currentEntryId) {
    assigned = await read(entryRef(window.currentSessionId, window.currentEntryId));
    if (!inScope(assigned) || !["called", "in_progress"].includes(assigned.status) || assigned.sessionId !== window.currentSessionId
      || assigned.calledWindowId !== window.id || assigned.calledByShiftId !== window.currentShiftId
      || assigned.calledByStaffId !== window.currentStaffId || (assigned.callAttemptId ?? null) !== (window.currentCallAttemptId ?? null)) fail("Ticket snapshots disagree.");
  }
  function staffNeedMoreTimeMix() {
    const attempt = context.callAttemptId ?? null;
    if (context.action !== "staff_need_more_time" || context.preStatus !== "in_progress" || context.staffNeedMoreTimeAt != null) return false;
    if (!window || !original || !oldShift || assigned || !attempt || !context.entryId || !context.windowId || !context.shiftId || !context.staffId || !context.sessionId) return false;
    if (context.windowEntryId !== context.entryId || (context.windowCallAttemptId ?? null) !== attempt || context.windowSessionId !== context.sessionId) return false;
    if (original.id !== context.entryId || original.status !== "in_progress" || (original.callAttemptId ?? null) !== attempt || original.sessionId !== context.sessionId) return false;
    if (original.calledWindowId !== window.id || original.calledWindowId !== context.windowId || original.calledByShiftId !== context.shiftId || original.calledByStaffId !== context.staffId) return false;
    if ((original.queueOrder ?? null) !== (context.queueOrder ?? null) || original.staffNeedMoreTimeAt != null) return false;
    if (window.id !== context.windowId || window.currentStaffId !== context.staffId || window.currentShiftId !== context.shiftId || window.state !== context.preWindowState) return false;
    if (window.currentEntryId != null || window.currentSessionId != null || window.currentCallAttemptId != null || window.currentTicketLabel != null || window.currentEntryCalledAt != null) return false;
    if (oldShift.id !== window.currentShiftId || oldShift.staffId !== window.currentStaffId || oldShift.windowId !== window.id || oldShift.state !== window.state || oldShift.endedAt != null) return false;
    return oldShift.currentEntryId == null && oldShift.currentSessionId == null;
  }
  const deferStaffNeedMoreTime = staffNeedMoreTimeMix();
  if (!deferStaffNeedMoreTime && window && original && ["called", "in_progress"].includes(original.status) && original.calledWindowId === window.id
    && (original.id !== assigned?.id || (original.callAttemptId ?? null) !== (assigned?.callAttemptId ?? null))) fail("Ticket snapshots disagree.");
  function promoteConfirmedPresent(secondByPath) {
    if (context.action !== "confirm_present" || !original) return false;
    const entryPath = entryRef(context.sessionId, context.entryId).path;
    const mismatched = [...observed.values()].filter(row => signature(row.target, secondByPath.get(row.target.path)) !== row.signature);
    if (mismatched.length !== 1 || mismatched[0].target.path !== entryPath) return false;
    const first = original;
    const secondData = secondByPath.get(entryPath);
    if (!secondData) return false;
    const second = { id: first.id, ...secondData };
    const attempt = value => value ?? null;
    const sameAssignment = ticket => attempt(ticket.callAttemptId) === attempt(context.callAttemptId)
      && ticket.calledWindowId === context.windowId
      && ticket.calledByShiftId === context.shiftId
      && ticket.calledByStaffId === context.staffId;
    if (!sameAssignment(first) || !sameAssignment(second)) return false;
    if (context.preStatus !== "called" || first.status !== "called" || second.status !== "in_progress") return false;
    if (!Object.prototype.hasOwnProperty.call(first, "confirmedPresentAt") || first.confirmedPresentAt != null) return false;
    if (typeof second.confirmedPresentAt?.toMillis !== "function") return false;
    const ignore = new Set(["id", "status", "confirmedPresentAt"]);
    const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
    for (const key of keys) {
      if (ignore.has(key)) continue;
      const inFirst = Object.prototype.hasOwnProperty.call(first, key);
      const inSecond = Object.prototype.hasOwnProperty.call(second, key);
      if (!inFirst || !inSecond || JSON.stringify(first[key]) !== JSON.stringify(second[key])) return false;
    }
    original = second;
    if (assigned && assigned.id === second.id && attempt(assigned.callAttemptId) === attempt(second.callAttemptId)) assigned = second;
    return true;
  }
  function proveStaffNeedMoreTime(secondByPath) {
    const entryPath = entryRef(context.sessionId, context.entryId).path;
    const secondData = secondByPath.get(entryPath);
    if (!secondData) return false;
    const second = { id: original.id, ...secondData };
    if (second.id !== context.entryId || second.sessionId !== context.sessionId || second.status !== "waiting" || (second.callAttemptId ?? null) !== null) return false;
    if (typeof second.staffNeedMoreTimeAt?.toMillis !== "function" || !Number.isFinite(second.queueOrder)) return false;
    if (second.calledWindowId !== context.windowId || second.calledByShiftId !== context.shiftId || second.calledByStaffId !== context.staffId) return false;
    const allow = new Set(["id", "status", "callAttemptId", "staffNeedMoreTimeAt", "queueOrder"]);
    const keys = new Set([...Object.keys(original), ...Object.keys(second)]);
    for (const key of keys) {
      if (allow.has(key)) continue;
      const inFirst = Object.prototype.hasOwnProperty.call(original, key);
      const inSecond = Object.prototype.hasOwnProperty.call(second, key);
      if (!inFirst || !inSecond || JSON.stringify(original[key]) !== JSON.stringify(second[key])) return false;
    }
    const sessionPath = ref("sessions", context.sessionId).path;
    for (const row of observed.values()) {
      const next = secondByPath.get(row.target.path);
      if (row.target.path === entryPath) continue;
      if (row.target.path === sessionPath) {
        if (signature(row.target, next) === row.signature) continue;
        if (!next || !row.value) return false;
        const first = { ...row.value };
        delete first.id;
        const names = new Set([...Object.keys(first), ...Object.keys(next)]);
        for (const key of names) {
          if (key === "queueRevision") continue;
          const inFirst = Object.prototype.hasOwnProperty.call(first, key);
          const inSecond = Object.prototype.hasOwnProperty.call(next, key);
          if (!inFirst || !inSecond || JSON.stringify(first[key]) !== JSON.stringify(next[key])) return false;
        }
        const before = Number(first.queueRevision || 0), after = Number(next.queueRevision || 0);
        if (after !== before && after !== before + 1) return false;
        continue;
      }
      if (signature(row.target, next) !== row.signature) return false;
    }
    const windowData = secondByPath.get(ref("windows", context.windowId).path);
    const shiftData = secondByPath.get(ref("shifts", context.shiftId).path);
    if (!windowData || !shiftData) return false;
    original = second;
    window = { id: window.id, ...windowData };
    oldShift = { id: oldShift.id, ...shiftData };
    if (currentShift && currentShift.id === oldShift.id) currentShift = oldShift;
    return true;
  }
  const secondByPath = new Map();
  const checks = await Promise.all([...observed.values()].map(async row => {
    const second = (await getDocFromServer(row.target)).data() ?? null;
    secondByPath.set(row.target.path, second);
    return signature(row.target, second) === row.signature;
  }));
  if (deferStaffNeedMoreTime) {
    if (!proveStaffNeedMoreTime(secondByPath)) fail("Ticket snapshots disagree.");
  } else if (checks.some(value => !value) && !promoteConfirmedPresent(secondByPath)) fail("State changed while checking. Check current state again.");
  const sameAttempt = original && (original.callAttemptId ?? null) === context.callAttemptId;
  let outcome = "Current authoritative state is shown. Make any further action a new decision.";
  if (context.action === "call") outcome = assigned ? "Current assignment: " + assigned.ticketLabel + ". No additional call was made." : "Window is currently idle. The earlier call result is unknown; CALL NEXT is a new decision.";
  else if (context.action === "end" && oldShift?.endedAt) outcome = "The original shift has ended. Current ownership is shown.";
  else if (["pause", "resume"].includes(context.action)) outcome = "Window is currently " + window.state + ". The earlier action was not replayed.";
  else if (original) {
    const desired = context.action === "confirm_present" ? "in_progress" : context.action;
    if (sameAttempt && original.status === desired) outcome = original.ticketLabel + ": " + original.status.toUpperCase() + " is recorded. No action was repeated.";
    else if (context.action === "staff_need_more_time" && original.staffNeedMoreTimeAt?.toMillis?.() !== context.staffNeedMoreTimeAt && original.staffNeedMoreTimeAt) outcome = original.ticketLabel + ": staff Need More Time is recorded; current state is " + original.status.toUpperCase() + ". No reposition was repeated.";
    else if (sameAttempt && original.status === context.preStatus) outcome = original.ticketLabel + ": the original state remains. You may make a new deliberate decision.";
    else outcome = original.ticketLabel + ": current state is " + original.status.toUpperCase() + ". The old action is no longer applicable.";
  }
  return { original, window, oldShift, person, currentShift, currentPerson, assigned, queue, outcome };
}

export function actionReconciliation(host, changed, apply) {
  const pending = new Map();
  const key = context => context.windowId ? "window:" + context.windowId : "ticket:" + context.sessionId + ":" + context.entryId;
  const blocked = (windowId, entryId = null, sessionId = null) => pending.has("window:" + windowId) || pending.has("ticket:" + sessionId + ":" + entryId);
  const rejected = error => ["operation-blocked", "stale-call-attempt", "eta-unavailable", "permission-denied", "invalid-argument", "failed-precondition"].includes((error.code || "").replace(/^firestore\//, ""));
  function render() {
    host.replaceChildren();
    for (const row of pending.values()) {
      const box = element("div", undefined, "notice");
      box.append(element("p", row.context.action.toUpperCase() + ": " + row.message));
      box.append(actionButton("Check current state", () => check(row.context), row.checking));
      host.append(box);
    }
  }
  async function check(context) {
    const row = pending.get(key(context));
    if (!row || row.checking) return;
    row.checking = true; row.message = "Checking current state..."; changed();
    try {
      const state = await reconcileAction(context);
      apply(state); pending.delete(key(context));
      host.dataset.outcome = state.outcome;
    } catch (_) { row.message = "Unable to confirm current state. No action was replayed."; }
    finally { row.checking = false; changed(); }
  }
  async function run(context, work) {
    if (blocked(context.windowId, context.entryId, context.sessionId)) return { uncertain: true };
    try { return { value: await work() }; }
    catch (error) {
      if (rejected(error)) throw error;
      pending.set(key(context), { context, checking: false, message: "Checking current state..." });
      changed(); await check(context);
      return { uncertain: true };
    }
  }
  return { blocked, render, run };
}

export const PRESENCE_RENEWAL_MS = 120000;
export const PRESENCE_GRACE_MS = 300000;

// Presentation only. Never infer expiry or staff absence from a local clock.
export function windowPresenceText(window) {
  if (!window.active || window.state === "inactive") return "Inactive — not contributing to estimated wait times.";
  if (!window.currentShiftId || window.state === "available") return "Available — no active shift. Not contributing to estimated wait times.";
  const state = windowPresenceState(window);
  const currentEvidence = state !== "legacy";
  const last = currentEvidence ? " Last confirmed: " + new Date(window.lastPresenceAt.toMillis()).toLocaleTimeString() + "." : "";
  if (window.state === "paused") return "Paused — not contributing to estimated wait times." + last;
  if (state === "excluded") return "Window active — capacity temporarily excluded. Presence not recently confirmed. Your assigned customer remains assigned." + last;
  if (currentEvidence) return "Window active — presence confirmed. Contributing to estimated wait times." + last;
  return window.lastPresenceAt?.toMillis
    ? "Window active — presence awaiting confirmation for this assignment. Not contributing to estimated wait times."
    : "Window active — presence not yet established. Existing capacity is unchanged.";
}

// Missing or previous-shift evidence is legacy, not proof of absence.
// Expiry is recorded only by a server-validated write.

async function readPresenceAssignment(tx, windowId, staffId, shiftId) {
  const a = await readAssignment(tx, windowId, shiftId);
  if (a.window.currentStaffId !== staffId) fail("Presence assignment has changed.");
  if (a.window.currentEntryId) {
    const ticket = data(await tx.get(entryRef(a.window.currentSessionId, a.window.currentEntryId)), "Assigned ticket not found.");
    if (!inScope(ticket) || ticket.sessionId !== a.window.currentSessionId || !["called", "in_progress"].includes(ticket.status)
      || ticket.calledWindowId !== windowId || ticket.calledByStaffId !== staffId || ticket.calledByShiftId !== shiftId
      || (ticket.callAttemptId ?? null) !== (a.window.currentCallAttemptId ?? null)) fail("Presence assignment pointers disagree.");
  }
  return a;
}

export async function renewWindowPresence(windowId, staffId, shiftId, browserId) {
  if (typeof browserId !== "string" || !browserId || browserId.length > 120) fail("Invalid presence browser ID.");
  return runTransaction(db, async tx => {
    const a = await readPresenceAssignment(tx, windowId, staffId, shiftId);
    tx.update(a.windowRef, { presenceStaffId: staffId, presenceShiftId: shiftId,
      lastPresenceAt: serverTimestamp(), lastPresenceBrowserId: browserId, capacityExcludedAt: null });
  });
}

export async function excludeWindowCapacity(windowId, staffId, shiftId, expectedLastPresenceAt = null) {
  return runTransaction(db, async tx => {
    const a = await readPresenceAssignment(tx, windowId, staffId, shiftId);
    if (a.window.state !== "active" || windowPresenceState(a.window) !== "valid"
      || expectedLastPresenceAt && a.window.lastPresenceAt.toMillis() !== expectedLastPresenceAt.toMillis()) return false;
    // No client-time decision: rules check current evidence against request.time.
    tx.update(a.windowRef, { capacityExcludedAt: serverTimestamp() });
    return true;
  });
}

export function staffPresence(getAssignment, fresh) {
  const browserId = crypto.randomUUID();
  let key = "", confirmed = false, running = false, stopped = false;
  async function renew() {
    const a = getAssignment();
    if (stopped || running || !a || !fresh() || !navigator.onLine) return;
    running = true;
    try { await renewWindowPresence(a.windowId, a.staffId, a.shiftId, browserId); }
    catch (error) { console.warn("Presence renewal:", error); }
    finally { running = false; }
  }
  function sync() {
    // Our own pending-write metadata must not schedule another renewal.
    if (running) return;
    const a = getAssignment(), next = a ? [a.windowId, a.staffId, a.shiftId].join(":") : "";
    const ready = Boolean(a && fresh() && navigator.onLine);
    const renewNow = ready && (next !== key || !confirmed);
    key = next; confirmed = ready;
    if (renewNow) void renew();
  }
  const visible = () => { if (document.visibilityState === "visible") void renew(); };
  const timer = setInterval(renew, PRESENCE_RENEWAL_MS);
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
  return { sync, stop() { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible);
    window.removeEventListener("online", sync); window.removeEventListener("offline", sync); } };
}

export function operationalFreshness(changed) {
  const sources = new Map();
  const confirmed = names => navigator.onLine && names.every(name => sources.get(name) === true);
  const observe = name => metadata => sources.set(name, Boolean(navigator.onLine && metadata && !metadata.fromCache && !metadata.hasPendingWrites));
  const reset = name => sources.delete(name);
  const state = names => confirmed(names) ? "server-confirmed" : navigator.onLine ? "uncertain" : "stale";
  const offline = () => { for (const name of sources.keys()) sources.set(name, false); changed(); };
  const online = () => changed();
  window.addEventListener("offline", offline); window.addEventListener("online", online);
  return { confirmed, observe, reset, state };
}
export function watchStaff(next, error, metadata) {
  return watchData(query(collection(db, "staff"), where("businessId", "==", BUSINESS_ID)), snapshot => next(snapshot.docs.map(s => ({ id: s.id, ...s.data() })).sort((a, b) => a.name.localeCompare(b.name))), error, metadata);
}
export function watchWindows(next, error, metadata) {
  return watchData(query(collection(db, "windows"), where("queueId", "==", QUEUE_ID)), snapshot => next(snapshot.docs.map(s => ({ id: s.id, ...s.data() })).filter(inScope).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))), error, metadata);
}
export function watchPerson(staffId, next, error, metadata) {
  return watchData(ref("staff", staffId), snapshot => next(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null), error, metadata);
}
export function watchEntry(sessionId, customerId, next, error, metadata) {
  return watchData(entryRef(sessionId, customerId), snapshot => next(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null), error, metadata);
}
export function watchQueue(next, error, metadata) {
  return watchData(ref("queues", QUEUE_ID), snapshot => next(snapshot.exists() ? snapshot.data() : null), error, metadata);
}
export function watchEntries(sessionId, status, next, error, metadata) {
  return watchData(query(collection(db, "sessions", sessionId, "entries"), status === "called" ? where("status", "in", ["called", "in_progress"]) : where("status", "==", status), orderBy(status === "waiting" ? "joinedAt" : "calledAt", "asc")), snapshot => {
    const entries = snapshot.docs.map(s => ({ id: s.id, ...s.data() }));
    next(status === "waiting" ? entries.sort(compareWaiting) : entries);
  }, error, metadata);
}
// Bound learning reads to the newest 40 samples.
export function watchServiceSamples(next, error) {
  return onSnapshot(query(collection(db, "queues", QUEUE_ID, "serviceSamples"), orderBy("recordedAt", "desc"), limit(40)), snapshot => next(snapshot.docs.map(s => ({ id: s.id, ...s.data() })).reverse()), error);
}

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function actionButton(label, action, disabled = false) {
  const button = element("button", label);
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}
