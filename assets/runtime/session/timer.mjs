/** The countdown in the top bar. Fires `onExpire` once when it reaches zero. */

import { formatClock } from "../shared/dom.mjs";

export function createTimer({ element, timerMs, startedAt, endedAt, onExpire }) {
  let state = { timerMs, startedAt: startedAt ?? null, endedAt: endedAt ?? null };
  let expired = false;
  let handle = null;

  function remaining(now = Date.now()) {
    if (state.startedAt === null) return state.timerMs;
    const end = state.endedAt ?? now;
    return Math.max(0, state.startedAt + state.timerMs - end);
  }

  function render() {
    const ms = remaining();
    element.textContent = formatClock(ms);
    element.classList.toggle("warn", ms > 0 && ms <= 5 * 60_000);
    element.classList.toggle("danger", ms > 0 && ms <= 60_000);
    element.classList.toggle("stopped", state.endedAt !== null);
    if (ms === 0 && !expired && state.startedAt !== null && state.endedAt === null) {
      expired = true;
      onExpire?.();
    }
  }

  handle = setInterval(render, 500);
  render();

  return {
    /** Apply a `phase` event payload from the server. */
    update(payload) {
      state = {
        timerMs: payload.timerMs ?? state.timerMs,
        startedAt: payload.startedAt ?? state.startedAt,
        endedAt: payload.endedAt ?? null,
      };
      render();
    },
    stop() {
      if (handle) clearInterval(handle);
    },
  };
}
