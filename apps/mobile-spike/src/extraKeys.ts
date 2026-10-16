// Touch "extra keys" bar for CodeMirror 6. Ctrl / Alt are sticky modifiers:
// tap once, the next key (bar key or physical key) gets the modifier, then it clears.

import { EditorView, runScopeHandlers } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import {
  cursorCharLeft, cursorCharRight, cursorLineUp, cursorLineDown,
  cursorLineBoundaryBackward, cursorLineBoundaryForward, cursorDocStart, cursorDocEnd,
  insertTab, undo, redo, simplifySelection,
} from "@codemirror/commands";
import { closeSearchPanel, searchPanelOpen } from "@codemirror/search";
import { cursorThaiWordLeft, cursorThaiWordRight, selectThaiWord } from "./thaiWords";

type Mods = { ctrl: boolean; alt: boolean };

export interface ExtraKeysOptions { onToast?: (msg: string) => void }

export function mountExtraKeys(host: HTMLElement, view: EditorView, opts: ExtraKeysOptions = {}) {
  const mods: Mods = { ctrl: false, alt: false };
  const toast = opts.onToast ?? (() => {});
  const buttons = new Map<string, HTMLButtonElement>();

  const render = () => {
    buttons.get("Ctrl")?.classList.toggle("sticky", mods.ctrl);
    buttons.get("Alt")?.classList.toggle("sticky", mods.alt);
  };
  const consumeMods = (): Mods => { const m = { ...mods }; mods.ctrl = mods.alt = false; render(); return m; };

  const fireKey = (key: string, m: Mods) => {
    // Route through CodeMirror's keymaps so bar keys behave exactly like a physical keyboard.
    const ev = new KeyboardEvent("keydown", { key, ctrlKey: m.ctrl, altKey: m.alt, bubbles: true, cancelable: true });
    return runScopeHandlers(view, ev, "editor");
  };

  const actions: Record<string, (m: Mods) => void> = {
    Tab: m => { if (!fireKey("Tab", m)) insertTab(view); },
    Esc: m => {
      if (!fireKey("Escape", m)) { if (searchPanelOpen(view.state)) closeSearchPanel(view); else simplifySelection(view); }
    },
    "←": m => { if (m.ctrl || m.alt) cursorThaiWordLeft(view); else cursorCharLeft(view); },
    "→": m => { if (m.ctrl || m.alt) cursorThaiWordRight(view); else cursorCharRight(view); },
    "↑": m => { if (m.ctrl) cursorDocStart(view); else cursorLineUp(view); },
    "↓": m => { if (m.ctrl) cursorDocEnd(view); else cursorLineDown(view); },
    Home: m => { if (m.ctrl) cursorDocStart(view); else cursorLineBoundaryBackward(view); },
    End: m => { if (m.ctrl) cursorDocEnd(view); else cursorLineBoundaryForward(view); },
    Undo: () => { undo(view); },
    Redo: () => { redo(view); },
    Sel: () => { selectThaiWord(view); },
    Copy: async () => {
      const { from, to } = view.state.selection.main;
      const text = from === to ? view.state.doc.lineAt(from).text + "\n" : view.state.sliceDoc(from, to);
      try { await navigator.clipboard.writeText(text); toast(`Copied ${text.length} chars`); }
      catch (e) { toast("Clipboard write failed: " + (e as Error).message); }
    },
    Paste: async () => {
      try {
        const text = await navigator.clipboard.readText();
        view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.paste" });
        toast(`Pasted ${text.length} chars`);
      } catch (e) { toast("Clipboard read failed: " + (e as Error).message); }
    },
  };

  const order = ["Tab", "Esc", "Ctrl", "Alt", "←", "↑", "↓", "→", "Home", "End", "Undo", "Redo", "Sel", "Copy", "Paste"];
  for (const label of order) {
    const b = document.createElement("button");
    b.type = "button"; b.tabIndex = -1; b.textContent = label; b.dataset.key = label;
    b.setAttribute("aria-label", label === "Sel" ? "Select word" : label);
    if (label === "Ctrl" || label === "Alt") b.classList.add("mod");
    // Keep focus (and the soft keyboard) in the editor: prevent the default focus change.
    b.addEventListener("pointerdown", e => e.preventDefault());
    b.addEventListener("mousedown", e => e.preventDefault());
    b.addEventListener("click", () => {
      if (label === "Ctrl") { mods.ctrl = !mods.ctrl; render(); return; }
      if (label === "Alt") { mods.alt = !mods.alt; render(); return; }
      const m = consumeMods();
      actions[label](m);
      if (!view.hasFocus) view.focus();
    });
    host.appendChild(b); buttons.set(label, b);
  }

  // Sticky modifiers also apply to the next physical/virtual key (works when the
  // keyboard reports a real `key`; Gboard often reports "Unidentified"/229 — see REPORT).
  const keyHandler = EditorView.domEventHandlers({
    keydown(e, v) {
      if (!mods.ctrl && !mods.alt) return false;
      if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Unidentified") return false;
      const m = consumeMods();
      const synth = new KeyboardEvent("keydown", { key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: m.ctrl || e.ctrlKey, altKey: m.alt || e.altKey, bubbles: true, cancelable: true });
      if (runScopeHandlers(v, synth, "editor")) { e.preventDefault(); return true; }
      return false;
    },
  });

  return { extension: keyHandler, mods, buttons, press: (label: string) => buttons.get(label)?.click() };
}

export { EditorSelection };
