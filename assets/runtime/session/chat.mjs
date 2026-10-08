/** The interviewer panel: messages both ways and the approach note. */

import { postJson } from "../shared/api.mjs";
import { el } from "../shared/dom.mjs";

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function createChat({ sessionId, notify }) {
  const list = document.getElementById("messages");
  const form = document.getElementById("composer");
  const text = document.getElementById("composer-text");

  function append(message) {
    const li = el(
      "li",
      { class: `message from-${message.from}` },
      el("div", { class: "message-from" }, message.from === "interviewer" ? "Interviewer" : "You"),
      el("div", { class: "message-body", html: message.html }),
    );
    list.append(li);
    li.scrollIntoView({ block: "nearest" });
  }

  async function send() {
    const value = text.value.trim();
    if (!value) return;
    text.disabled = true;
    try {
      await postJson(`/api/sessions/${sessionId}/message`, { text: value });
      text.value = "";
    } catch (err) {
      notify?.(err.message, "error");
    } finally {
      text.disabled = false;
      text.focus();
    }
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void send();
  });
  text?.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void send();
    }
  });

  return {
    append,
    noteAdded(note) {
      append({ from: "candidate", html: `<em>Approach:</em> ${escapeHtml(note.text)}` });
    },
  };
}
