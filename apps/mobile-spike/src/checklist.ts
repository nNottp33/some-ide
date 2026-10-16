// Manual device checklist with results persisted in localStorage.

export interface CheckItem { id: string; title: string; desc: string }
export type Result = "pass" | "fail" | "skip";
export interface Stored { results: Record<string, { result: Result; note: string; at: string }>; }

export const CHECKS: CheckItem[] = [
  { id: "ime-thai-compose", title: "Thai IME composition (Gboard Thai / iOS Thai keyboard)", desc: "Type สวัสดี, น้ำ, ผู้ใช้, ป้า in a comment: vowel/tone marks attach to the right consonant, no duplicated or dropped characters, no cursor jump during composition." },
  { id: "ime-mid-word", title: "Compose inside an existing Thai word", desc: "Place the cursor inside กรุงเทพมหานคร and type ๆ or a vowel; the text is inserted where the caret is and the rest of the word is untouched." },
  { id: "ime-backspace", title: "Backspace over Thai clusters", desc: "Backspace in น้ำ removes marks/consonants in the order the keyboard expects (Gboard: one code point at a time) and never leaves the document inconsistent with what is shown." },
  { id: "ime-autocorrect", title: "Autocorrect / predictive text does not mangle code", desc: "Typing const foo = 1; in TS sample does not get auto-capitalised or auto-corrected (autocorrect/autocapitalize are off on the editor)." },
  { id: "sel-handles", title: "Selection handles", desc: "Long-press a word: native handles appear and can be dragged; the editor's selection (search highlight, extra-key Copy) follows the handles." },
  { id: "sel-doubletap-thai", title: "Double-tap selects one Thai word", desc: "Double-tap on กรุงเทพมหานคร selects a dictionary word (native word break), not the whole run of Thai letters." },
  { id: "longpress-menu", title: "Long-press context menu", desc: "Cut / Copy / Paste / Select all appear and work; Paste inserts at the caret." },
  { id: "scroll-vs-select", title: "Scroll vs select", desc: "One-finger drag scrolls the document; it never starts a selection. Drag on a selection handle extends selection. No accidental selection when flicking." },
  { id: "scroll-120hz", title: "Smooth scrolling in the 20k-line file (?big=1)", desc: "Flick scrolling runs without jank; on a 120 Hz display it feels like 120 Hz (compare with a native text view). Note the phone model." },
  { id: "kb-cursor-visible", title: "Soft keyboard keeps the caret visible", desc: "Tap a line in the lower half of the screen: when the keyboard opens the caret line stays visible and the extra-keys bar sits directly above the keyboard." },
  { id: "kb-extra-keys-focus", title: "Extra keys do not dismiss the keyboard", desc: "Tapping Tab, arrows, Undo etc. keeps the keyboard open and the caret in the editor." },
  { id: "kb-sticky-mods", title: "Sticky Ctrl/Alt", desc: "Tap Ctrl then → : caret moves by Thai word. Tap Ctrl then type z on the soft keyboard: undo (may not work on Gboard, which reports Unidentified keys)." },
  { id: "ext-keyboard", title: "External (Bluetooth) keyboard shortcuts", desc: "Ctrl+→/←, Ctrl+Z/Y, Ctrl+F, Ctrl+Backspace work; Thai layout typing on the physical keyboard composes correctly." },
  { id: "clipboard-api", title: "Copy/Paste via clipboard API", desc: "Copy / Paste extra keys work (a permission prompt may appear on Android/iOS; note the behaviour in the WebView)." },
  { id: "font-thai-marks", title: "Thai tone marks render in the monospace font", desc: "Marks in น้ำ ป้า ผู้ใช้ are not clipped by the line height, and the caret does not sit between a consonant and its mark when moving with ←/→." },
  { id: "orientation", title: "Landscape / rotation", desc: "Rotate the phone: layout reflows, caret remains visible, keyboard and extra keys reposition correctly." },
  { id: "pinch-zoom", title: "Pinch zoom", desc: "Pinch zoom is blocked by the viewport meta (or behaves acceptably); text size stays readable." },
];

const KEY = "cm6-thai-spike-checklist";

export function load(): Stored {
  try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw) as Stored; } catch { /* ignore */ }
  return { results: {} };
}
export function save(s: Stored) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } }

export function deviceInfo() {
  const vv = window.visualViewport;
  return {
    userAgent: navigator.userAgent,
    platform: (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
    screen: `${screen.width}x${screen.height} @${devicePixelRatio}x`,
    innerSize: `${innerWidth}x${innerHeight}`,
    visualViewport: vv ? `${Math.round(vv.width)}x${Math.round(vv.height)} scale=${vv.scale}` : "n/a",
    segmenter: typeof Intl !== "undefined" && "Segmenter" in Intl,
    touchPoints: navigator.maxTouchPoints,
    lang: navigator.language,
    date: new Date().toISOString(),
  };
}

export function exportResults(stored: Stored) {
  return JSON.stringify({ device: deviceInfo(), checks: CHECKS.map(c => ({ id: c.id, title: c.title, ...(stored.results[c.id] ?? { result: null, note: "" }) })) }, null, 2);
}

export function mountChecklist(host: HTMLElement, onToast: (m: string) => void) {
  const stored = load();
  host.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = "Device checklist ";
  const close = document.createElement("button"); close.textContent = "Close"; close.id = "checklist-close";
  close.addEventListener("click", () => { host.hidden = true; });
  h.appendChild(close); host.appendChild(h);

  const dev = document.createElement("div"); dev.className = "device";
  dev.textContent = Object.entries(deviceInfo()).map(([k, v]) => `${k}: ${v}`).join("\n");
  host.appendChild(dev);

  const actions = document.createElement("div"); actions.className = "actions";
  const exportBtn = document.createElement("button"); exportBtn.textContent = "Export results"; exportBtn.id = "export-results";
  const clearBtn = document.createElement("button"); clearBtn.textContent = "Clear results";
  actions.append(exportBtn, clearBtn); host.appendChild(actions);
  const out = document.createElement("textarea"); out.id = "export-output"; out.readOnly = true; out.placeholder = "Exported JSON appears here (also copied to clipboard and offered as a download)."; host.appendChild(out);

  exportBtn.addEventListener("click", async () => {
    const json = exportResults(stored);
    out.value = json;
    try { await navigator.clipboard.writeText(json); onToast("Results copied to clipboard"); } catch { onToast("Clipboard unavailable; use the text box"); }
    try {
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `cm6-thai-checklist-${Date.now()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch { /* ignore */ }
  });
  clearBtn.addEventListener("click", () => { stored.results = {}; save(stored); mountChecklist(host, onToast); });

  for (const c of CHECKS) {
    const item = document.createElement("div"); item.className = "item"; item.dataset.id = c.id;
    const title = document.createElement("div"); title.className = "title"; title.textContent = c.title;
    const desc = document.createElement("div"); desc.className = "desc"; desc.textContent = c.desc;
    const row = document.createElement("div"); row.className = "row";
    const mk = (r: Result, label: string) => {
      const b = document.createElement("button"); b.textContent = label; b.dataset.result = r;
      b.addEventListener("click", () => {
        stored.results[c.id] = { result: r, note: note.value, at: new Date().toISOString() }; save(stored); paint();
      });
      return b;
    };
    const pass = mk("pass", "Pass"), fail = mk("fail", "Fail"), skip = mk("skip", "Skip");
    const note = document.createElement("input"); note.placeholder = "note"; note.value = stored.results[c.id]?.note ?? "";
    note.addEventListener("change", () => { const cur = stored.results[c.id]; if (cur) { cur.note = note.value; save(stored); } });
    const paint = () => {
      const r = stored.results[c.id]?.result;
      pass.className = r === "pass" ? "sel-pass" : ""; fail.className = r === "fail" ? "sel-fail" : ""; skip.className = r === "skip" ? "sel-skip" : "";
    };
    paint();
    row.append(pass, fail, skip, note); item.append(title, desc, row); host.appendChild(item);
  }
}
