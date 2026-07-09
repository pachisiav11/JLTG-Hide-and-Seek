// Soft per-question timer (Phase 11). A visible countdown the group can run once a
// question is asked — deliberately SOFT: it never blocks adding another question
// (JLTG is planning-oriented / single-device), it just counts down and flags when
// time's up. One timer at a time; starting a new one replaces any running one.
// Reference: gelbh shows a countdown per question.

let state = null;

export function startCountdown(seconds, { onEnd, label = "Question" } = {}) {
  stopCountdown();
  let remaining = Math.max(1, Math.round(seconds));

  const bar = document.createElement("div");
  bar.id = "q-timer";
  bar.className = "q-timer";
  bar.innerHTML = `<span class="q-timer-label"></span><span class="q-timer-time"></span><button class="q-timer-x" aria-label="Stop timer">✕</button>`;
  bar.querySelector(".q-timer-label").textContent = label;
  document.body.appendChild(bar);
  const timeEl = bar.querySelector(".q-timer-time");

  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const paint = () => (timeEl.textContent = `⏱ ${fmt(remaining)}`);
  paint();

  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(interval);
      bar.classList.add("done");
      timeEl.textContent = "⏱ Time!";
      onEnd?.();
      return; // leave the banner up (with ✕) so the alert is noticeable
    }
    paint();
  }, 1000);

  bar.querySelector(".q-timer-x").onclick = () => stopCountdown();
  state = { bar, interval };
}

export function stopCountdown() {
  if (!state) return;
  clearInterval(state.interval);
  state.bar.remove();
  state = null;
}

export function isRunning() {
  return !!state;
}
