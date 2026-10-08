/**
 * The session's phase: briefing → coding → follow-ups → finished.
 *
 * Owns the approach-note form and the Start button, and enables or disables the
 * editor actions as the phase changes.
 */

import { postJson } from "../shared/api.mjs";

const LABELS = { briefing: "Briefing", coding: "Coding", review: "Follow-ups", done: "Finished" };

export function createPhase({ sessionId, initial, onChange, notify }) {
  let phase = initial;
  const badge = document.getElementById("phase");
  const briefing = document.getElementById("briefing");
  const runButton = document.getElementById("run-button");
  const submitButton = document.getElementById("submit-button");
  const doneButton = document.getElementById("done-button");
  const hintButton = document.getElementById("hint-button");
  const form = document.getElementById("approach-form");
  const text = document.getElementById("approach-text");
  const skip = document.getElementById("skip-note-button");

  function apply(next) {
    phase = next;
    if (badge) {
      badge.textContent = LABELS[phase] ?? phase;
      badge.className = `phase-badge phase-${phase}`;
    }
    if (briefing) briefing.hidden = phase !== "briefing";
    const canCode = phase === "coding" || phase === "review";
    if (runButton) runButton.disabled = !canCode;
    if (submitButton) submitButton.disabled = !canCode;
    if (doneButton) doneButton.disabled = phase === "review" || phase === "done";
    if (hintButton && phase === "done") hintButton.disabled = true;
    onChange?.(phase);
  }

  async function start(withNote) {
    try {
      if (withNote && text && text.value.trim()) {
        await postJson(`/api/sessions/${sessionId}/note`, { text: text.value.trim() });
      }
      const { session } = await postJson(`/api/sessions/${sessionId}/start`);
      apply(session.phase);
    } catch (err) {
      notify?.(err.message, "error");
    }
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (text && !text.value.trim()) {
      text.focus();
      notify?.("Write a sentence about your approach, or skip the note.", "warn");
      return;
    }
    void start(true);
  });
  skip?.addEventListener("click", () => void start(false));

  doneButton?.addEventListener("click", async () => {
    if (
      !window.confirm(
        "Tell the interviewer you're done? You can still answer follow-ups and run code.",
      )
    )
      return;
    try {
      const { session } = await postJson(`/api/sessions/${sessionId}/done`);
      apply(session.phase);
    } catch (err) {
      notify?.(err.message, "error");
    }
  });

  apply(initial);
  return {
    get current() {
      return phase;
    },
    apply,
  };
}
