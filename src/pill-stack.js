// Phase 29 (req #11): one shared foreground pill stack.
//
// The geofence and live-share pills were each `position: fixed` at a hand-tuned
// `bottom` (12 px and 46 px) in the bottom-right corner — directly in the path
// of the bottom-centre floating toolbar on narrow screens, and guaranteed to
// collide the moment a third pill (e.g. Phase 35's "Location on") appeared,
// since the offsets were coordinated by hand.
//
// This module replaces both with a single fixed container lifted ABOVE the
// toolbar. Pills are flex-column children, so N of them stack with a gap and
// never overlap by construction — no more coordinated `bottom` values. Each
// pill carries a dismiss (×) control that hides ONLY the DOM indicator; the
// caller's GPS watch keeps running, because dismiss is a view concern, not a
// teardown. That separation is the crux of the feature and the thing the tests
// pin: hiding the pill must not touch the subscription.
//
// The DOM is factored out here (behind an injectable `doc`) so the stacking and
// dismiss behaviour can be unit-tested against a tiny fake document, without a
// full JSDOM dependency the project doesn't otherwise carry.

const STACK_ID = "pill-stack";

// Return the single shared stack container, creating it on first use. Returns
// null in a non-DOM environment so callers can no-op safely.
export function getPillStack(doc = (typeof document !== "undefined" ? document : null)) {
  if (!doc || typeof doc.createElement !== "function") return null;
  const existing = typeof doc.getElementById === "function" ? doc.getElementById(STACK_ID) : null;
  if (existing) return existing;
  const stack = doc.createElement("div");
  stack.id = STACK_ID;
  stack.className = "pill-stack";
  if (typeof doc.body?.appendChild === "function") doc.body.appendChild(stack);
  return stack;
}

// Build a pill (text span + dismiss button) inside the shared stack. Returns a
// small handle the caller drives — it never reaches back into the caller's
// state. `onDismiss` (optional) fires AFTER the pill is hidden so a caller can
// note "the user hid this" for its own view logic; it must never be used to
// stop a watch.
export function createPill({ id, variant, doc = (typeof document !== "undefined" ? document : null), onDismiss } = {}) {
  const stack = getPillStack(doc);
  if (!stack) return null;

  const el = doc.createElement("div");
  el.id = id;
  el.className = `pill${variant ? ` pill-${variant}` : ""}`;

  const text = doc.createElement("span");
  text.className = "pill-text";

  const dismiss = doc.createElement("button");
  dismiss.type = "button";
  dismiss.className = "pill-dismiss";
  dismiss.textContent = "×"; // ×
  if (typeof dismiss.setAttribute === "function") dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.onclick = () => {
    el.classList.add("pill-hidden");
    try { onDismiss?.(); } catch (e) { console.warn("pill dismiss handler threw", e); }
  };

  el.appendChild(text);
  el.appendChild(dismiss);
  stack.appendChild(el);

  return {
    el,
    setText(t) { text.textContent = t; },
    setWarn(on) { el.classList.toggle("pill-warn", !!on); },
    // Re-show a previously dismissed pill (e.g. the feature was toggled off then
    // back on and the caller wants a fresh, visible indicator).
    show() { el.classList.remove("pill-hidden"); },
    remove() { el.remove(); },
  };
}
