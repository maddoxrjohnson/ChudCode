/**
 * The Next problem button: press it, wait for the interviewer, follow it to the new
 * session. The rows are rendered by src/server/pages/next-up.ts; the status texts
 * here mirror its nextStatusText.
 */

import { postJson } from "./api.mjs";

const STATUS = {
  waiting: () => "Waiting for the interviewer to open it…",
  away: (row) =>
    `The interviewer is away. Type ${row.dataset.command} in your terminal to carry on.`,
  ready: (row) =>
    row.dataset.prepared === "1"
      ? "Written and validated: it opens at once."
      : "The interviewer writes it when you press, in about a minute.",
};

/** `from` is the session page the press comes from, so the server sends it on too. */
export function createNextUp({ from } = {}) {
  let connected = null;
  let navigating = false;
  const rows = () => [...document.querySelectorAll(".next-up")];

  function setState(row, state) {
    row.dataset.state = state;
    row.querySelector(".next-button").disabled = state !== "ready";
    row.querySelector(".next-status").textContent = STATUS[state](row);
  }

  function idle(row) {
    const isConnected = connected ?? row.dataset.state !== "away";
    setState(row, isConnected ? "ready" : "away");
  }

  async function press(row) {
    setState(row, "waiting");
    try {
      const url = row.dataset.url ?? `/api/roadmaps/${row.dataset.roadmap}/next`;
      await postJson(url, from ? { from } : {});
    } catch (err) {
      idle(row);
      row.querySelector(".next-status").textContent = err.message;
    }
  }

  function bind(root = document) {
    for (const row of root.querySelectorAll(".next-up")) {
      const button = row.querySelector(".next-button");
      if (button.dataset.bound) continue;
      button.dataset.bound = "1";
      button.addEventListener("click", () => void press(row));
    }
  }

  bind();
  return {
    bind,
    get navigating() {
      return navigating;
    },
    presence(isConnected) {
      connected = isConnected;
      for (const row of rows()) if (row.dataset.state !== "waiting") idle(row);
    },
    pending(request) {
      for (const row of rows()) {
        if (row.dataset.roadmap === request.roadmap) setState(row, "waiting");
        else if (row.dataset.state === "waiting") idle(row);
      }
    },
    open(payload) {
      navigating = true;
      window.location.href = payload.url;
    },
  };
}
