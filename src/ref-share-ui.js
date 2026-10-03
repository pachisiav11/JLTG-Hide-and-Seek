// The seeker's "📤 Copy for hider" panel, embedded in every question sheet whose reference the
// seekers chose (see question-ref.js for which those are and why).
//
// Two-step on purpose: the first tap only shows what will be sent — the reference AND the
// seekers' own side (their distance, their nearest POI…) in plain words — and the seeker copies
// from there. The seekers' side is a number or choice the SEEKER entered; it may have been
// prefilled from GPS, so it is put in front of them to check before it leaves the phone rather
// than sent on the strength of a prefill. The panel re-reads the sheet on every input, so what
// is copied is always what the sheet says at that moment, never a stale preview.
import * as store from "./store.js";
import { buildQuestionRef, questionRefText, parseQuestionRef, describeReference, describeSeekerSide, refFromStep, seekerFromStep } from "./question-ref.js";
import { openSheet, toast, escapeHtml, formatDistance } from "./ui.js";

export function sharePanelHTML() {
  return `
    <div class="share-ref">
      <button id="sr-open" class="btn" type="button">📤 Copy for hider</button>
      <div id="sr-body" class="share-ref-body" hidden>
        <p class="muted">Check this before you send it — the hider answers against exactly this.</p>
        <p id="sr-summary" class="share-ref-summary"></p>
        <textarea id="sr-text" class="field" rows="3" readonly></textarea>
        <div class="row">
          <button id="sr-copy" class="btn btn-primary" type="button">Copy</button>
          <button id="sr-send" class="btn" type="button" hidden>Send…</button>
        </div>
        <p id="sr-status" class="muted"></p>
      </div>
    </div>`;
}

const units = () => store.getCurrent()?.settings?.units || "metric";

// Build → text → parse back. Parsing our own output is cheap and means the preview the seeker
// approves is the hider's reading of the message, not the seeker's intent.
function render(sheet, build) {
  const summary = sheet.q("#sr-summary"), area = sheet.q("#sr-text"), status = sheet.q("#sr-status");
  const copy = sheet.q("#sr-copy"), send = sheet.q("#sr-send");
  try {
    const fc = buildQuestionRef(build());
    const text = questionRefText(fc);
    const ref = parseQuestionRef(text);
    const fmt = (m) => formatDistance(m, units());
    const side = describeSeekerSide(ref, fmt);
    summary.innerHTML = `<strong>${escapeHtml(ref.title)}</strong> — ${escapeHtml(describeReference(ref))}.${side ? `<br>${escapeHtml(side)}` : ""}`;
    area.value = text;
    area.hidden = false;
    copy.disabled = false;
    send.hidden = !(typeof navigator !== "undefined" && typeof navigator.share === "function");
    status.textContent = "";
    return { text, ref };
  } catch (e) {
    summary.textContent = "";
    area.value = "";
    area.hidden = true;
    copy.disabled = true;
    send.hidden = true;
    status.textContent = e.message || "Couldn't build the message.";
    return null;
  }
}

/**
 * Wire a sharePanelHTML() block inside `sheet`.
 *   build() → { tool, inputs, seeker } from the sheet's CURRENT state, or throws an Error whose
 *             message tells the seeker what is missing ("Enter your distance first…").
 *   open    → start expanded (the committed-question sheet, where sending is the only purpose).
 */
export function wireSharePanel(sheet, build, { open = false } = {}) {
  const body = sheet.q("#sr-body");
  if (!body) return;
  const show = () => { body.hidden = false; sheet.q("#sr-open").hidden = true; render(sheet, build); };
  sheet.q("#sr-open").onclick = show;
  // Keep the preview honest while the seeker edits the sheet around it.
  const refresh = (e) => { if (!body.hidden && !body.contains(e.target)) render(sheet, build); };
  sheet.el.addEventListener("input", refresh);
  sheet.el.addEventListener("change", refresh);
  sheet.q("#sr-copy").onclick = async () => {
    const out = render(sheet, build); // copy what the sheet says NOW
    if (!out) return;
    try {
      await navigator.clipboard.writeText(out.text);
      sheet.q("#sr-status").textContent = "Copied — paste it to the hider. They paste it into Questions ▸ 📥 Received question.";
    } catch {
      // Clipboard is permission-gated and blocked outright in some in-app browsers.
      const area = sheet.q("#sr-text");
      area.focus(); area.select();
      sheet.q("#sr-status").textContent = "Couldn't copy automatically — the text is selected, copy it manually.";
    }
  };
  sheet.q("#sr-send").onclick = async () => {
    const out = render(sheet, build);
    if (!out) return;
    try { await navigator.share({ title: out.ref.title, text: out.text }); sheet.q("#sr-status").textContent = "Sent."; }
    catch (e) { if (e?.name !== "AbortError") sheet.q("#sr-status").textContent = "Couldn't open the share sheet — use Copy instead."; }
  };
  if (open) show();
}

/** "📤" on a committed question's row: the same panel, built from the step itself. */
export function openStepShareSheet(step, { onClose } = {}) {
  let first;
  try { first = refFromStep(step); }
  catch (e) { toast(e.message); return null; }
  const s = openSheet({
    title: "Send to hider",
    bodyHTML: `<p class="muted">The reference for <strong>${escapeHtml(first.jltg.title)}</strong>, with your side of it as you entered it. The hider's answer is not included.</p>${sharePanelHTML()}`,
    onClose,
  });
  // Same seeker rule as refFromStep, so the row button and a rebuild cannot disagree.
  wireSharePanel(s, () => ({ tool: step.tool, inputs: step.inputs, seeker: seekerFromStep(step) }), { open: true });
  return s;
}
