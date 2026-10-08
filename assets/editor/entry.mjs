/**
 * entry.mjs: the source of the vendored CodeMirror bundle.
 *
 * Composes the editor explicitly rather than through `basicSetup`, which hard-wires
 * autocompletion. Completion and the dark theme live in compartments so the page can
 * toggle them without rebuilding the editor. Run `npm run bundle:editor` after
 * changing this file; CI fails if the committed bundle is stale.
 */

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";

const completionExtensions = () => [autocompletion(), closeBrackets()];

/**
 * @param {object} options
 * @param {HTMLElement} options.parent
 * @param {string} [options.doc]
 * @param {boolean} [options.autocomplete]
 * @param {boolean} [options.dark]
 * @param {(text: string) => void} [options.onChange]
 */
export function createEditor({ parent, doc = "", autocomplete = false, dark = false, onChange }) {
  const completion = new Compartment();
  const theme = new Compartment();

  const state = EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      rectangularSelection(),
      crosshairCursor(),
      indentUnit.of("    "),
      EditorState.tabSize.of(4),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      python(),
      completion.of(autocomplete ? completionExtensions() : []),
      theme.of(dark ? oneDark : []),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && onChange) onChange(update.state.doc.toString());
      }),
    ],
  });

  const view = new EditorView({ state, parent });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    setAutocomplete(on) {
      view.dispatch({ effects: completion.reconfigure(on ? completionExtensions() : []) });
    },
    setDark(on) {
      view.dispatch({ effects: theme.reconfigure(on ? oneDark : []) });
    },
    focus: () => view.focus(),
  };
}
