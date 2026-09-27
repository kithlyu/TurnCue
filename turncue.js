// Shared Batch 2 operations. Staff ID confirmation is NOT authentication.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getFirestore, doc, collection, getDoc, getDocFromServer, getDocsFromServer, query, where,
  orderBy, limit, startAfter, onSnapshot, runTransaction, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { isInactivityDue, pendingCheckDecision } from "./inactivity.js";
import { normalizeWindowLabel } from "./bulk-setup.js";

const firebaseConfig = {
  apiKey: "AIzaSyCngq4CXYVHXBqr_zipMgIqPiDWxzlpIVM",
  authDomain: "turncue-83e1a.firebaseapp.com",
  projectId: "turncue-83e1a",
  storageBucket: "turncue-83e1a.firebasestorage.app",
  messagingSenderId: "459437201769",
  appId: "1:459437201769:web:1859490f3db0f3fc2945f8"
};
export const db = getFirestore(initializeApp(firebaseConfig));
export const BUSINESS_ID = "demo-business";
export const LOCATION_ID = "main-location";
export const QUEUE_ID = "main-queue";
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

export async function callNext(windowId, expectedShiftId, sessionId, source = "staff") {
  if (!sessionId) fail("There is no open session.");
  // The web SDK cannot transactionally query a collection. Fetch the earliest
  // candidate from the SERVER, then read and verify it inside the transaction.
  // Losing a candidate race causes a fresh query, never a successful no-op.
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidates = await getDocsFromServer(query(collection(db, "sessions", sessionId, "entries"), where("status", "==", "waiting"), orderBy("joinedAt", "asc"), limit(1)));
    if (candidates.empty) return null;
    const candidateRef = candidates.docs[0].ref;
    const eventRef = newRef("windowEvents");
    try {
      return await runTransaction(db, async tx => {
        const a = await readAssignment(tx, windowId, expectedShiftId);
        const customer = data(await tx.get(candidateRef), "Customer no longer exists.");
        const session = data(await tx.get(ref("sessions", sessionId)), "Session no longer exists.");
        const queue = data(await tx.get(ref("queues", QUEUE_ID)), "Queue no longer exists.");
        if (a.window.state !== "active") fail("Resume this window before calling next.");
        if (a.window.currentEntryId || a.shift.currentEntryId) fail("Complete the current customer before calling next.");
        if (!inScope(session) || session.status !== "open" || queue.currentSessionId !== sessionId) fail("The operational session has changed. Wait for the dashboard to refresh.");
        if (customer.status !== "waiting") fail("Another window called this customer.", "candidate-lost");
        if (!inScope(customer) || customer.sessionId !== sessionId) fail("Customer belongs to another queue.");
        tx.update(candidateRef, { status: "called", calledAt: serverTimestamp(), calledByStaffId: a.window.currentStaffId, calledByShiftId: expectedShiftId, calledWindowId: windowId, calledWindowLabel: a.window.name, etaLearningEligible: true });
        tx.update(a.windowRef, { currentEntryId: candidateRef.id, currentSessionId: sessionId, currentTicketLabel: customer.ticketLabel, currentEntryCalledAt: serverTimestamp(), lastActionAt: serverTimestamp(), updatedAt: serverTimestamp(), lastEventId: eventRef.id, ...clearInactivity });
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
      }
      if (!["candidate-lost", "aborted", "firestore/aborted"].includes(error.code)) throw error;
    }
  }
  fail("The queue is changing quickly. No new call was confirmed. Check your window and try again.");
}

export async function completeCustomer(sessionId, customerId, windowId = null, expectedShiftId = null, source = "staff") {
  const eventRef = newRef("windowEvents");
  return runTransaction(db, async tx => {
    const customerRef = entryRef(sessionId, customerId);
    const customer = data(await tx.get(customerRef), "Customer not found.");
    if (!inScope(customer) || customer.sessionId !== sessionId || customer.status !== "called") fail("This customer is no longer awaiting completion.");
    if (!customer.calledWindowId) {
      // Historical Batch 1 calls have no window assignment to release.
      if (source !== "manager") fail("Ask the manager to complete this earlier call.");
      tx.update(customerRef, { status: "completed", completedAt: serverTimestamp() });
      return;
    }
    const a = await readAssignment(tx, windowId, expectedShiftId);
    if (customer.calledWindowId !== windowId || customer.calledByShiftId !== expectedShiftId || customer.calledByStaffId !== a.window.currentStaffId || a.window.currentEntryId !== customerId || a.window.currentSessionId !== sessionId) fail("This customer is not assigned to this shift.");
    const cleanEligible = customer.etaLearningEligible === true && Boolean(customer.calledAt?.toMillis?.());
    tx.update(customerRef, { status: "completed", completedAt: serverTimestamp() });
    // Entry ID is deterministic: repeated completion cannot duplicate a sample.
    tx.set(sampleRef(customerId), { ...scope, sessionId, entryId: customerId, windowId, shiftId: expectedShiftId,
      // Both timestamps are server-authoritative. eta.js derives duration only
      // after Firestore resolves them, never from a staff device clock.
      calledAt: customer.calledAt || null, completedAt: serverTimestamp(), durationSeconds: null, durationMinutes: null,
      cleanEligible, exclusionReason: cleanEligible ? null : (customer.etaExclusionReason || "invalid_or_legacy_service"), recordedAt: serverTimestamp() });
    tx.update(a.windowRef, { currentEntryId: null, currentSessionId: null, currentTicketLabel: null, currentEntryCalledAt: null, lastActionAt: serverTimestamp(), updatedAt: serverTimestamp(), lastEventId: eventRef.id, ...clearInactivity });
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
export function watchStaff(next, error) {
  return onSnapshot(query(collection(db, "staff"), where("businessId", "==", BUSINESS_ID)), snapshot => next(snapshot.docs.map(s => ({ id: s.id, ...s.data() })).sort((a, b) => a.name.localeCompare(b.name))), error);
}
export function watchWindows(next, error) {
  return onSnapshot(query(collection(db, "windows"), where("queueId", "==", QUEUE_ID)), snapshot => next(snapshot.docs.map(s => ({ id: s.id, ...s.data() })).filter(inScope).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))), error);
}
export function watchPerson(staffId, next, error) {
  return onSnapshot(ref("staff", staffId), snapshot => next(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null), error);
}
export function watchQueue(next, error) {
  return onSnapshot(ref("queues", QUEUE_ID), snapshot => next(snapshot.exists() ? snapshot.data() : null), error);
}
export function watchEntries(sessionId, status, next, error) {
  return onSnapshot(query(collection(db, "sessions", sessionId, "entries"), where("status", "==", status), orderBy(status === "waiting" ? "joinedAt" : "calledAt", "asc")), snapshot => next(snapshot.docs.map(s => ({ id: s.id, ...s.data() }))), error);
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
