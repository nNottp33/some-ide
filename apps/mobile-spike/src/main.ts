import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, rectangularSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle, indentUnit, syntaxTreeAvailable } from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { thaiWords, thaiWordAt, thaiWordBoundary, segmentText } from "./thaiWords";
import { mountExtraKeys } from "./extraKeys";
import { mountChecklist, CHECKS } from "./checklist";
import { tsSample, pySample, bigSample } from "./samples";

const params = new URLSearchParams(location.search);
const big = params.get("big") === "1";
const langParam = params.get("lang") ?? "ts";
const wrapParam = params.get("wrap") === "1";
const noLang = params.get("nolang") === "1"; // perf comparison: no syntax parser

const toastEl = document.getElementById("toast")!;
let toastTimer = 0;
function toast(msg: string) {
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, 1800);
}

const langComp = new Compartment(), wrapComp = new Compartment(), themeComp = new Compartment();
const dark = matchMedia("(prefers-color-scheme: dark)").matches;

const host = document.getElementById("editor-host")!;
const extraKeysHost = document.getElementById("extra-keys")!;

let extraKeys: ReturnType<typeof mountExtraKeys> | null = null;
const extraKeysExt = new Compartment();

const t0 = performance.now();
const doc = big ? bigSample(20000) : langParam === "py" ? pySample : tsSample;

const view = new EditorView({
  parent: host,
  state: EditorState.create({
    doc,
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(),
      history(),
      bracketMatching(),
      highlightActiveLine(), highlightSelectionMatches(),
      rectangularSelection(),
      search({ top: true }),
      indentUnit.of("  "),
      thaiWords(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      langComp.of(noLang ? [] : langParam === "py" ? python() : javascript({ typescript: true })),
      wrapComp.of(wrapParam ? EditorView.lineWrapping : []),
      themeComp.of(dark ? oneDark : syntaxHighlighting(defaultHighlightStyle)),
      extraKeysExt.of([]),
      EditorView.contentAttributes.of({ autocorrect: "off", autocapitalize: "off", spellcheck: "false" }),
      EditorView.updateListener.of(u => { if (u.selectionSet || u.docChanged) updateStatus(); }),
    ],
  }),
});
const createMs = performance.now() - t0;

extraKeys = mountExtraKeys(extraKeysHost, view, { onToast: toast });
view.dispatch({ effects: extraKeysExt.reconfigure(extraKeys.extension) });

// ---- toolbar ----
const statusEl = document.getElementById("status")!;
function updateStatus() {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  statusEl.textContent = `L${line.number}:${head - line.from + 1} · ${view.state.doc.lines} lines`;
}
updateStatus();

const langSel = document.getElementById("lang") as HTMLSelectElement;
langSel.value = langParam === "py" ? "py" : "ts";
langSel.addEventListener("change", () => {
  const py = langSel.value === "py";
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: big ? view.state.doc.toString() : py ? pySample : tsSample },
    effects: langComp.reconfigure(py ? python() : javascript({ typescript: true })),
  });
  view.focus();
});
const wrapBtn = document.getElementById("wrap")!;
let wrapOn = wrapParam;
wrapBtn.classList.toggle("on", wrapOn);
wrapBtn.addEventListener("click", () => {
  wrapOn = !wrapOn; wrapBtn.classList.toggle("on", wrapOn);
  view.dispatch({ effects: wrapComp.reconfigure(wrapOn ? EditorView.lineWrapping : []) });
});
const kbsimBtn = document.getElementById("kbsim")!;
let kbSim = false;
kbsimBtn.addEventListener("click", () => {
  kbSim = !kbSim; kbsimBtn.classList.toggle("on", kbSim);
  document.documentElement.style.setProperty("--kb-sim", kbSim ? "300px" : "0px");
  keepCursorVisible();
});
const checklistEl = document.getElementById("checklist")!;
document.getElementById("checklist-btn")!.addEventListener("click", () => {
  checklistEl.hidden = !checklistEl.hidden;
  if (!checklistEl.hidden) mountChecklist(checklistEl, toast);
});

// ---- visualViewport handling (soft keyboard) ----
function applyViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : innerHeight;
  const top = vv ? vv.offsetTop : 0;
  document.documentElement.style.setProperty("--vvh", `${Math.round(h)}px`);
  document.documentElement.style.setProperty("--vv-top", `${Math.round(top)}px`);
}
let rafPending = 0;
function keepCursorVisible() {
  applyViewport();
  cancelAnimationFrame(rafPending);
  rafPending = requestAnimationFrame(() => {
    view.requestMeasure();
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "nearest", yMargin: 24 }) });
  });
}
applyViewport();
window.visualViewport?.addEventListener("resize", keepCursorVisible);
window.visualViewport?.addEventListener("scroll", applyViewport);
window.addEventListener("resize", keepCursorVisible);
window.addEventListener("orientationchange", keepCursorVisible);

// ---- test hooks ----
declare global { interface Window { __cm: unknown } }
window.__cm = {
  view, EditorView, thaiWordAt, thaiWordBoundary, segmentText, extraKeys, CHECKS, createMs,
  big, noLang, parsed: () => syntaxTreeAvailable(view.state, view.state.doc.length), text: () => view.state.doc.toString(), sel: () => { const r = view.state.selection.main; return { from: r.from, to: r.to, anchor: r.anchor, head: r.head }; },
  cursorRect: () => { const r = view.state.selection.main; return view.coordsAtPos(r.head); },
  editorRect: () => view.scrollDOM.getBoundingClientRect().toJSON(),
  keepCursorVisible,
};
toast(big ? `Loaded ${view.state.doc.lines} lines in ${createMs.toFixed(0)} ms` : "Ready");
