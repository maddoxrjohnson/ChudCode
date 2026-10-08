/** Mount the vendored CodeMirror editor and wire the autocomplete toggle. */

import { createEditor } from "../../vendor/codemirror.bundle.mjs";

export function mountEditor({ host, doc, autocomplete, dark, onChange }) {
  host.textContent = "";
  const editor = createEditor({ parent: host, doc, autocomplete, dark, onChange });

  const toggle = document.getElementById("autocomplete-toggle");
  if (toggle) {
    try {
      const stored = localStorage.getItem("chudcode-autocomplete");
      if (stored === "on" || stored === "off") {
        toggle.checked = stored === "on";
        editor.setAutocomplete(toggle.checked);
      }
    } catch {
      /* storage unavailable */
    }
    toggle.addEventListener("change", () => {
      editor.setAutocomplete(toggle.checked);
      try {
        localStorage.setItem("chudcode-autocomplete", toggle.checked ? "on" : "off");
      } catch {
        /* storage unavailable */
      }
    });
  }
  return editor;
}
