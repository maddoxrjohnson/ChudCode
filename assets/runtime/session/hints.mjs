/** The hint ladder: one button, progressively more specific hints. */

import { postJson } from "../shared/api.mjs";
import { el } from "../shared/dom.mjs";

export function createHints({ sessionId, used, total, notify }) {
  const button = document.getElementById("hint-button");
  const list = document.getElementById("hint-list");
  const shown = new Set(used);
  let locked = false;

  function render() {
    if (!button) return;
    button.textContent = `Hint (${shown.size}/${total} used)`;
    button.disabled = locked || shown.size >= total;
  }

  function show(hint) {
    if (shown.has(hint.level)) return;
    shown.add(hint.level);
    list.append(
      el(
        "li",
        { class: "hint" },
        el("span", { class: "hint-level" }, `Hint ${hint.level}`),
        ` ${hint.text}`,
      ),
    );
    render();
  }

  button?.addEventListener("click", async () => {
    if (!window.confirm("Reveal the next hint? Hints you use are part of the debrief.")) return;
    button.disabled = true;
    try {
      const { hint } = await postJson(`/api/sessions/${sessionId}/hint`);
      show(hint);
    } catch (err) {
      notify?.(err.message, "error");
    } finally {
      render();
    }
  });

  render();
  return {
    show,
    lock() {
      locked = true;
      render();
    },
  };
}
