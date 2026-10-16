// Thai-aware word navigation / selection for CodeMirror 6.
//
// CodeMirror's default word boundaries come from a per-character categorizer
// (word / space / other), so a run of Thai letters without spaces is one
// "word". This extension uses Intl.Segmenter('th', { granularity: 'word' })
// (ICU dictionary-based word break) to find real Thai word boundaries. Latin
// identifiers, numbers and punctuation are handled by the same segmenter
// (UAX #29), so the commands behave like the defaults on non-Thai code.
//
// Usage:  extensions: [thaiWords()]
// Exposes: thaiWordAt, cursorThaiWordLeft/Right, selectThaiWordLeft/Right,
//          selectThaiWord, deleteThaiWordBackward/Forward.

import { EditorSelection, EditorState, Prec, type Extension, type SelectionRange } from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";

export interface Segment { from: number; to: number; wordLike: boolean; text: string }

let segmenter: Intl.Segmenter | null = null;
export function thaiSegmenter(): Intl.Segmenter | null {
  if (segmenter) return segmenter;
  try {
    if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
      segmenter = new Intl.Segmenter("th", { granularity: "word" });
    }
  } catch { segmenter = null; }
  return segmenter;
}

// Small LRU-ish cache: segmenting a long line repeatedly during drag is wasteful.
const cache = new Map<string, Segment[]>();
export function segmentText(text: string): Segment[] {
  const hit = cache.get(text);
  if (hit) return hit;
  const seg = thaiSegmenter();
  let result: Segment[];
  if (!seg) {
    // Fallback: whitespace vs non-whitespace runs (no Thai awareness).
    result = [];
    const re = /\s+|\S+/g; let m: RegExpExecArray | null;
    while ((m = re.exec(text))) result.push({ from: m.index, to: m.index + m[0].length, wordLike: /\S/.test(m[0]), text: m[0] });
  } else {
    result = [];
    for (const s of seg.segment(text)) {
      result.push({ from: s.index, to: s.index + s.segment.length, wordLike: !!s.isWordLike, text: s.segment });
    }
  }
  if (cache.size > 2000) cache.clear();
  cache.set(text, result);
  return result;
}

const isSpace = (s: Segment) => !s.wordLike && /^\s+$/.test(s.text);

/** Word (or punctuation run) at `pos`, Thai-aware. Returns null on an empty line. */
export function thaiWordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  const off = pos - line.from;
  const segs = segmentText(line.text);
  if (!segs.length) return null;
  let seg = segs.find(s => s.from <= off && off < s.to) ?? null;
  const before = segs.find(s => s.to === off) ?? null;
  // Like CodeMirror: at a boundary, prefer the word-like side.
  if ((!seg || !seg.wordLike) && before && before.wordLike) seg = before;
  if (!seg) seg = before;
  if (!seg) return null;
  if (seg.wordLike || isSpace(seg)) return { from: line.from + seg.from, to: line.from + seg.to };
  // punctuation: extend over the run of adjacent punctuation segments (as CM does)
  let i = segs.indexOf(seg), j = i;
  while (i > 0 && !segs[i - 1].wordLike && !isSpace(segs[i - 1])) i--;
  while (j < segs.length - 1 && !segs[j + 1].wordLike && !isSpace(segs[j + 1])) j++;
  return { from: line.from + segs[i].from, to: line.from + segs[j].to };
}

/** Position of the next Thai-aware group boundary, mirroring CodeMirror's cursorGroupForward/Backward. */
export function thaiWordBoundary(state: EditorState, pos: number, forward: boolean): number {
  const line = state.doc.lineAt(pos);
  const off = pos - line.from;
  const segs = segmentText(line.text);
  if (forward) {
    if (off >= line.length) return Math.min(state.doc.length, line.to + (line.to < state.doc.length ? 1 : 0));
    let i = segs.findIndex(s => off < s.to);
    while (i < segs.length && isSpace(segs[i])) i++;
    if (i >= segs.length) return line.to;
    if (segs[i].wordLike) return line.from + segs[i].to;
    let j = i;
    while (j + 1 < segs.length && !segs[j + 1].wordLike && !isSpace(segs[j + 1])) j++;
    return line.from + segs[j].to;
  } else {
    if (off <= 0) return Math.max(0, line.from - (line.from > 0 ? 1 : 0));
    let i = -1;
    for (let k = segs.length - 1; k >= 0; k--) if (segs[k].from < off) { i = k; break; }
    while (i >= 0 && isSpace(segs[i])) i--;
    if (i < 0) return line.from;
    if (segs[i].wordLike) return line.from + segs[i].from;
    let j = i;
    while (j - 1 >= 0 && !segs[j - 1].wordLike && !isSpace(segs[j - 1])) j--;
    return line.from + segs[j].from;
  }
}

function moveSel(view: EditorView, forward: boolean, extend: boolean): boolean {
  const { state } = view;
  const sel = EditorSelection.create(state.selection.ranges.map((r: SelectionRange) => {
    const head = thaiWordBoundary(state, r.head, forward);
    return extend ? EditorSelection.range(r.anchor, head) : EditorSelection.cursor(head);
  }), state.selection.mainIndex);
  if (sel.eq(state.selection)) return false;
  view.dispatch(state.update({ selection: sel, scrollIntoView: true, userEvent: "select" }));
  return true;
}

export const cursorThaiWordLeft: Command = view => moveSel(view, false, false);
export const cursorThaiWordRight: Command = view => moveSel(view, true, false);
export const selectThaiWordLeft: Command = view => moveSel(view, false, true);
export const selectThaiWordRight: Command = view => moveSel(view, true, true);

/** Select the Thai-aware word around each cursor (used by the extra-keys "Sel" key). */
export const selectThaiWord: Command = view => {
  const { state } = view;
  const sel = EditorSelection.create(state.selection.ranges.map(r => {
    const w = thaiWordAt(state, r.head);
    return w ? EditorSelection.range(w.from, w.to) : r;
  }), state.selection.mainIndex);
  if (sel.eq(state.selection)) return false;
  view.dispatch(state.update({ selection: sel, userEvent: "select" }));
  return true;
};

function deleteWord(view: EditorView, forward: boolean): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const changes = state.changeByRange(r => {
    if (!r.empty) return { changes: { from: r.from, to: r.to }, range: EditorSelection.cursor(r.from) };
    const other = thaiWordBoundary(state, r.head, forward);
    const from = Math.min(r.head, other), to = Math.max(r.head, other);
    return { changes: { from, to }, range: EditorSelection.cursor(from) };
  });
  if (changes.changes.empty) return false;
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "delete.group" }));
  return true;
}
export const deleteThaiWordBackward: Command = view => deleteWord(view, false);
export const deleteThaiWordForward: Command = view => deleteWord(view, true);

export const thaiWordKeymap = [
  { key: "Ctrl-ArrowLeft", run: cursorThaiWordLeft, shift: selectThaiWordLeft, preventDefault: true },
  { key: "Ctrl-ArrowRight", run: cursorThaiWordRight, shift: selectThaiWordRight, preventDefault: true },
  { key: "Alt-ArrowLeft", run: cursorThaiWordLeft, shift: selectThaiWordLeft, preventDefault: true },
  { key: "Alt-ArrowRight", run: cursorThaiWordRight, shift: selectThaiWordRight, preventDefault: true },
  { key: "Ctrl-Backspace", run: deleteThaiWordBackward, preventDefault: true },
  { key: "Alt-Backspace", run: deleteThaiWordBackward, preventDefault: true },
  { key: "Ctrl-Delete", run: deleteThaiWordForward, preventDefault: true },
  { key: "Alt-Delete", run: deleteThaiWordForward, preventDefault: true },
];

/** Double-click (mouse detail == 2) selects a Thai-aware word; drag extends word-wise. */
const thaiMouseSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.detail !== 2 || event.button !== 0) return null;
  const rangeAt = (pos: number) => {
    const w = thaiWordAt(view.state, pos);
    return w ? EditorSelection.range(w.from, w.to) : EditorSelection.cursor(pos);
  };
  let start = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  let startSel = view.state.selection;
  return {
    update(update) {
      if (update.docChanged) { start = update.changes.mapPos(start); startSel = startSel.map(update.changes); }
    },
    get(ev, extend, multiple) {
      const cur = view.posAtCoords({ x: ev.clientX, y: ev.clientY }, false);
      let range = rangeAt(cur);
      if (start !== cur && !extend) {
        const sr = rangeAt(start);
        const from = Math.min(sr.from, range.from), to = Math.max(sr.to, range.to);
        range = from < range.from ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
      }
      if (extend) return startSel.replaceRange(startSel.main.extend(range.from, range.to));
      if (multiple) return startSel.addRange(range);
      return EditorSelection.create([range]);
    },
  };
});

export function thaiWords(): Extension {
  return [Prec.high(keymap.of(thaiWordKeymap)), thaiMouseSelection];
}
