// Playwright checks for the CodeMirror 6 phone-editor spike. Run: npm run test -w apps/mobile-spike (dev server must be on :5173)
import { chromium, devices } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SHOTS = path.join(ROOT, "shots"), RESULTS = path.join(ROOT, "results");
fs.mkdirSync(SHOTS, { recursive: true }); fs.mkdirSync(RESULTS, { recursive: true });

const THAI_TYPE = "สวัสดี น้ำ ผู้ใช้ 123 abc";
const THAI_INSERT = "กรุงเทพมหานคร ป้า ✓";

const seg = new Intl.Segmenter("th", { granularity: "word" });
const nodeSegments = text => [...seg.segment(text)].map(s => ({ from: s.index, to: s.index + s.segment.length, word: !!s.isWordLike, text: s.segment }));

function makeReport(name) {
  const r = { profile: name, checks: [], metrics: {}, notes: [] };
  r.check = (id, ok, detail) => { r.checks.push({ id, ok: !!ok, detail }); console.log(`[${name}] ${ok ? "PASS" : "FAIL"} ${id} ${detail ? "- " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); };
  r.note = (m) => { r.notes.push(m); console.log(`[${name}] NOTE ${m}`); };
  return r;
}

async function waitReady(page) {
  await page.waitForFunction(() => globalThis.__cm && globalThis.__cm.view);
}

async function openEditor(page, query = "") {
  await page.goto(BASE + "/" + query, { waitUntil: "load" });
  await waitReady(page);
  await page.waitForTimeout(150);
}

async function setCursor(page, pos) {
  await page.evaluate(p => { const v = __cm.view; v.focus(); v.dispatch({ selection: { anchor: p }, scrollIntoView: true }); }, pos);
  await page.waitForTimeout(50);
}

async function runProfile(browser, name, contextOpts, isTouch) {
  const R = makeReport(name);
  const context = await browser.newContext({ ...contextOpts, permissions: ["clipboard-read", "clipboard-write"], locale: "th-TH" });
  const page = await context.newPage();
  page.on("pageerror", e => R.note("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") R.note("console.error: " + m.text()); });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  await openEditor(page);
  const vp = page.viewportSize();
  R.metrics.viewport = vp;
  R.metrics.ua = await page.evaluate(() => navigator.userAgent);
  R.metrics.segmenter = await page.evaluate(() => typeof Intl.Segmenter === "function");
  R.check("intl-segmenter-available", R.metrics.segmenter);
  await page.screenshot({ path: path.join(SHOTS, `${name}-01-initial.png`) });
  await openEditor(page, "?lang=py&wrap=1"); await page.screenshot({ path: path.join(SHOTS, `${name}-01b-python-wrap.png`) }); await openEditor(page);

  // ---------- (a) typing Thai ----------
  {
    const docLen = await page.evaluate(() => __cm.view.state.doc.length);
    await setCursor(page, docLen);
    const t = Date.now();
    await page.keyboard.type(THAI_TYPE);
    const typeMs = Date.now() - t;
    let tail = await page.evaluate((n) => __cm.text().slice(-n), THAI_TYPE.length);
    R.check("a-keyboard-type-thai", tail === THAI_TYPE, { expected: THAI_TYPE, got: tail, ms: typeMs, codepoints: [...THAI_TYPE].length });
    await page.keyboard.insertText(THAI_INSERT);
    tail = await page.evaluate((n) => __cm.text().slice(-n), THAI_INSERT.length);
    R.check("a-insertText-thai", tail === THAI_INSERT, { expected: THAI_INSERT, got: tail });

    // Approximate IME composition via CDP (Input.imeSetComposition). Not a real IME.
    await page.evaluate(() => {
      const w = globalThis; w.__comp = { start: 0, update: 0, end: 0, data: [] };
      const c = __cm.view.contentDOM;
      c.addEventListener("compositionstart", () => w.__comp.start++);
      c.addEventListener("compositionupdate", e => { w.__comp.update++; w.__comp.data.push(e.data); });
      c.addEventListener("compositionend", e => { w.__comp.end++; w.__comp.data.push("END:" + e.data); });
    });
    const before = await page.evaluate(() => __cm.text().length);
    try {
      await page.keyboard.insertText(" ");
      // compose ส -> สว -> สวั -> สวัส -> สวัสดี then commit
      const steps = ["ส", "สว", "สวั", "สวัส", "สวัสด", "สวัสดี"];
      for (const s of steps) await cdp.send("Input.imeSetComposition", { text: s, selectionStart: s.length, selectionEnd: s.length });
      await cdp.send("Input.insertText", { text: "สวัสดี" });
      await page.waitForTimeout(100);
      const after = await page.evaluate(() => __cm.text());
      const comp = await page.evaluate(() => globalThis.__comp);
      const inserted = after.slice(before);
      R.check("a-cdp-ime-composition", inserted === " สวัสดี", { inserted, compositionEvents: comp });
    } catch (e) {
      R.check("a-cdp-ime-composition", false, "CDP Input.imeSetComposition unavailable: " + e.message);
    }
    // Backspace over a cluster: Chromium deletes one code point per Backspace for Thai.
    await page.keyboard.press("Backspace");
    const afterBs = await page.evaluate(() => __cm.text().slice(-6));
    const bsMode = afterBs.endsWith("สวัสด") ? "one-code-point (CM deleteCharBackward)" : afterBs.endsWith("สวัส") ? "whole-cluster (browser-native, CM Android path)" : "unexpected";
    R.check("a-backspace-thai", bsMode !== "unexpected", { got: afterBs, mode: bsMode, note: "desktop: CM handles Backspace and removes one code point; Android UA: CM lets the browser delete natively (cluster). Real Gboard/iOS path differs again, verify on device" });
    // Arrow left over a combining mark: caret should skip the cluster
    const posBefore = await page.evaluate(() => __cm.sel().head);
    await page.keyboard.press("ArrowLeft");
    const posAfter = await page.evaluate(() => __cm.sel().head);
    R.check("a-arrowleft-step", posBefore - posAfter >= 1, { stepCodeUnits: posBefore - posAfter, note: "CM moves by grapheme cluster (ดี -> 2 code units when mark present)" });
    // undo everything typed
    await page.evaluate(() => { const v = __cm.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: v.state.doc.toString() } }); });
    await openEditor(page); // reset doc
  }

  // ---------- (b) double-click Thai word ----------
  {
    const words = ["กรุงเทพมหานคร", "ผู้ใช้สามารถแก้ไข", "น้ำ"];
    for (const w of words) {
      const info = await page.evaluate((w) => {
        const v = __cm.view; const text = v.state.doc.toString(); const idx = text.indexOf(w);
        const line = v.state.doc.lineAt(idx); const off = idx - line.from;
        const probe = idx + Math.min(2, w.length - 1); // inside the word
        v.dispatch({ effects: __cm.EditorView.scrollIntoView(probe, { y: "center" }) });
        const r = v.coordsAtPos(probe);
        const cmDefault = v.state.wordAt(probe);
        return { idx, lineText: line.text, lineFrom: line.from, off, probe, x: (r.left + r.right) / 2 + 1, y: (r.top + r.bottom) / 2, cmDefault: cmDefault ? { from: cmDefault.from, to: cmDefault.to, text: text.slice(cmDefault.from, cmDefault.to) } : null };
      }, w);
      const expected = (() => {
        const segs = nodeSegments(info.lineText); const o = info.probe - info.lineFrom;
        const s = segs.find(s => s.from <= o && o < s.to); return { from: info.lineFrom + s.from, to: info.lineFrom + s.to, text: s.text };
      })();
      await page.mouse.dblclick(info.x, info.y);
      await page.waitForTimeout(80);
      const sel = await page.evaluate(() => { const s = __cm.sel(); return { ...s, text: __cm.text().slice(s.from, s.to) }; });
      R.check(`b-dblclick-${w}`, sel.from === expected.from && sel.to === expected.to, { selected: sel.text, expectedSegment: expected.text, cmDefaultWouldSelect: info.cmDefault?.text });
      if (isTouch && w === words[0]) {
        // informational: double tap through touch events
        await page.evaluate(() => __cm.view.dispatch({ selection: { anchor: 0 } }));
        await page.touchscreen.tap(info.x, info.y); await page.waitForTimeout(60); await page.touchscreen.tap(info.x, info.y);
        await page.waitForTimeout(150);
        const sel2 = await page.evaluate(() => { const s = __cm.sel(); return { ...s, text: __cm.text().slice(s.from, s.to) }; });
        R.note(`touchscreen double-tap on ${w}: selection="${sel2.text}" (${sel2.from}-${sel2.to}); emulated taps are synthesised into mousedown(detail=2) so CM's mouseSelectionStyle ran; a real Android/iOS double-tap runs the OS word selection instead (verify on device)`);
      }
    }
    await page.screenshot({ path: path.join(SHOTS, `${name}-02-dblclick-selection.png`) });
  }

  // ---------- (c) Ctrl+Right by Thai word ----------
  {
    const info = await page.evaluate(() => {
      const v = __cm.view; const text = v.state.doc.toString();
      const idx = text.indexOf("// ผู้ใช้"); const line = v.state.doc.lineAt(idx);
      return { lineFrom: line.from, lineTo: line.to, lineText: line.text, start: idx + 3 };
    });
    await setCursor(page, info.start);
    const heads = [];
    for (let i = 0; i < 8; i++) { await page.keyboard.press("Control+ArrowRight"); heads.push(await page.evaluate(() => __cm.sel().head)); }
    const segs = nodeSegments(info.lineText);
    const boundaries = new Set(segs.map(s => info.lineFrom + s.to));
    const wordsVisited = heads.map((h, i) => info.lineText.slice((i ? heads[i - 1] : info.start) - info.lineFrom, h - info.lineFrom));
    const allOnBoundary = heads.every(h => boundaries.has(h));
    const strictlyIncreasing = heads.every((h, i) => i === 0 ? h > info.start : h > heads[i - 1]);
    const wordLikeSteps = wordsVisited.filter(w => /[฀-๿]/.test(w)).length >= 3;
    R.check("c-ctrl-right-thai-words", allOnBoundary && strictlyIncreasing && wordLikeSteps, { steps: wordsVisited, heads });
    // Compare with CM default (cursorGroupRight) for the report
    const cmDefault = await page.evaluate((start) => {
      const v = __cm.view; v.dispatch({ selection: { anchor: start } });
      const before = v.state.selection.main.head;
      // emulate default: Mod-ArrowRight via standard command
      const r = v.state.wordAt(start); return { defaultWordAtCursor: r ? v.state.doc.sliceString(r.from, r.to) : null, before };
    }, info.start);
    R.note(`CM default word at the same spot would be: "${cmDefault.defaultWordAtCursor}"`);
    // Ctrl+Left back
    await page.keyboard.press("Control+ArrowLeft"); const back = await page.evaluate(() => __cm.sel().head);
    R.check("c-ctrl-left-thai-words", boundaries.has(back) || segs.some(s => info.lineFrom + s.from === back), { head: back });
    // Shift+Ctrl+Right selects
    await setCursor(page, info.start);
    await page.keyboard.press("Shift+Control+ArrowRight");
    const selText = await page.evaluate(() => { const s = __cm.sel(); return __cm.text().slice(s.from, s.to); });
    R.check("c-shift-ctrl-right-selects-word", selText.length > 0 && selText === wordsVisited[0], { selText });
    // Ctrl+Backspace deletes a Thai word
    await setCursor(page, heads[1]);
    await page.keyboard.press("Control+Backspace");
    const afterDel = await page.evaluate((f) => __cm.view.state.doc.lineAt(f).text, info.lineFrom);
    R.check("c-ctrl-backspace-thai-word", afterDel === info.lineText.replace(wordsVisited[1], "") , { line: afterDel });
    await page.keyboard.press("Control+z");
  }

  // ---------- (d) extra keys bar ----------
  {
    const press = async (label) => {
      const sel = `#extra-keys button[data-key="${label}"]`;
      if (isTouch) await page.tap(sel); else await page.click(sel);
      await page.waitForTimeout(40);
    };
    const info = await page.evaluate(() => { const v = __cm.view; const t = v.state.doc.toString(); const idx = t.indexOf("const greeting"); return { idx, line: v.state.doc.lineAt(idx).text }; });
    await setCursor(page, info.idx);
    await press("Tab");
    let line = await page.evaluate((i) => __cm.view.state.doc.lineAt(i).text, info.idx);
    const focusStays = await page.evaluate(() => document.activeElement === __cm.view.contentDOM);
    R.check("d-tab-inserts-indent", line !== info.line && /^\s+const greeting/.test(line), { line: JSON.stringify(line), focusStaysInEditor: focusStays });
    R.check("d-extra-key-keeps-focus", focusStays);
    await press("Undo");
    line = await page.evaluate((i) => __cm.view.state.doc.lineAt(i).text, info.idx);
    R.check("d-undo-key", line === info.line, { line: JSON.stringify(line) });
    await press("Redo");
    line = await page.evaluate((i) => __cm.view.state.doc.lineAt(i).text, info.idx);
    R.check("d-redo-key", /^\s+const greeting/.test(line));
    await press("Undo");
    await setCursor(page, info.idx);
    await press("→"); let h = await page.evaluate(() => __cm.sel().head);
    R.check("d-arrow-right-key", h === info.idx + 1, { head: h });
    await press("←"); h = await page.evaluate(() => __cm.sel().head);
    R.check("d-arrow-left-key", h === info.idx, { head: h });
    await press("↓"); h = await page.evaluate(() => __cm.sel().head);
    R.check("d-arrow-down-key", h > info.idx, { head: h });
    await press("↑"); h = await page.evaluate(() => __cm.sel().head);
    R.check("d-arrow-up-key", h === info.idx, { head: h });
    await press("End"); h = await page.evaluate(() => __cm.sel().head);
    R.check("d-end-key", h === info.idx + info.line.length, { head: h });
    await press("Home"); h = await page.evaluate(() => __cm.sel().head);
    R.check("d-home-key", h === info.idx, { head: h });
    // sticky Ctrl + → on a Thai word
    const thaiIdx = await page.evaluate(() => __cm.text().indexOf("ผู้ใช้ 42"));
    await setCursor(page, thaiIdx);
    await press("Ctrl");
    const sticky = await page.evaluate(() => document.querySelector('#extra-keys button[data-key="Ctrl"]').classList.contains("sticky"));
    await press("→"); h = await page.evaluate(() => __cm.sel().head);
    const stickyCleared = await page.evaluate(() => !document.querySelector('#extra-keys button[data-key="Ctrl"]').classList.contains("sticky"));
    const lineInfo = await page.evaluate((i) => { const l = __cm.view.state.doc.lineAt(i); return { from: l.from, text: l.text }; }, thaiIdx);
    const bset = new Set(nodeSegments(lineInfo.text).map(s => lineInfo.from + s.to));
    R.check("d-sticky-ctrl-arrow-word", sticky && stickyCleared && h > thaiIdx + 1 && bset.has(h), { moved: await page.evaluate(([a, b]) => __cm.text().slice(a, b), [thaiIdx, h]), sticky, stickyCleared });
    // Select-word key
    await setCursor(page, thaiIdx + 1);
    await press("Sel");
    const selW = await page.evaluate(() => { const s = __cm.sel(); return __cm.text().slice(s.from, s.to); });
    const expW = nodeSegments(lineInfo.text).find(s => s.from <= thaiIdx + 1 - lineInfo.from && thaiIdx + 1 - lineInfo.from < s.to).text;
    R.check("d-select-word-key", selW === expW, { selected: selW, expected: expW });
    // Copy / Paste through clipboard API
    await press("Copy");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    await setCursor(page, await page.evaluate(() => __cm.view.state.doc.length));
    await press("Paste");
    const tail = await page.evaluate((n) => __cm.text().slice(-n), selW.length);
    R.check("d-copy-paste-clipboard", clip === selW && tail === selW, { clip, tail });
    // Esc closes search panel
    await page.keyboard.press("Control+f");
    const open1 = await page.evaluate(() => !!document.querySelector(".cm-search"));
    await press("Esc");
    const open2 = await page.evaluate(() => !!document.querySelector(".cm-search"));
    R.check("d-esc-closes-search", open1 && !open2, { open1, open2 });
    await page.screenshot({ path: path.join(SHOTS, `${name}-03-extra-keys.png`) });
    await openEditor(page);
  }

  // ---------- (e) viewport shrink keeps caret visible ----------
  {
    const lines = await page.evaluate(() => __cm.view.state.doc.lines);
    // put the caret on a line near the bottom of the visible area
    const target = await page.evaluate(() => {
      const v = __cm.view; const rect = v.scrollDOM.getBoundingClientRect();
      const pos = v.posAtCoords({ x: rect.left + 60, y: rect.bottom - 30 }, false);
      v.focus(); v.dispatch({ selection: { anchor: pos } });
      return { pos, line: v.state.doc.lineAt(pos).number };
    });
    const visible = async () => page.evaluate(() => {
      const r = __cm.cursorRect(); const e = __cm.editorRect(); const keys = document.getElementById("extra-keys").getBoundingClientRect();
      return { caret: r && { top: r.top, bottom: r.bottom }, editor: { top: e.top, bottom: e.bottom }, keysBottom: keys.bottom, innerHeight, vvh: visualViewport.height,
        caretVisible: !!r && r.top >= e.top - 1 && r.bottom <= e.bottom + 1, keysInView: keys.bottom <= innerHeight + 1 && keys.top >= 0 };
    });
    const before = await visible();
    const shrunk = { width: vp.width, height: Math.round(vp.height * 0.45) };
    await page.setViewportSize(shrunk);
    await page.waitForTimeout(250);
    const after = await visible();
    R.check("e-viewport-shrink-caret-visible", before.caretVisible && after.caretVisible && after.keysInView, { line: target.line, before, after, shrunkTo: shrunk });
    await page.screenshot({ path: path.join(SHOTS, `${name}-04-viewport-shrunk.png`) });
    await page.setViewportSize(vp);
    await page.waitForTimeout(200);
    // in-page keyboard simulation button (300px)
    await page.evaluate((p) => { const v = __cm.view; v.focus(); v.dispatch({ selection: { anchor: p } }); }, target.pos);
    if (isTouch) await page.tap("#kbsim"); else await page.click("#kbsim");
    await page.waitForTimeout(250);
    const sim = await visible();
    const keysAbove = await page.evaluate(() => { const k = document.getElementById("extra-keys").getBoundingClientRect(); return Math.abs(k.bottom - (innerHeight - 300)) < 2; });
    R.check("e-kb-sim-caret-visible", sim.caretVisible && keysAbove, { sim, keysBarBottomAtKeyboardTop: keysAbove });
    await page.screenshot({ path: path.join(SHOTS, `${name}-05-kb-sim.png`) });
    if (isTouch) await page.tap("#kbsim"); else await page.click("#kbsim");
    void lines;
  }

  // ---------- checklist panel ----------
  {
    if (isTouch) await page.tap("#checklist-btn"); else await page.click("#checklist-btn");
    await page.waitForSelector("#checklist .item");
    const n = await page.evaluate(() => document.querySelectorAll("#checklist .item").length);
    const first = page.locator('#checklist .item').first();
    await first.locator('button[data-result="pass"]').click();
    await page.reload(); await waitReady(page);
    if (isTouch) await page.tap("#checklist-btn"); else await page.click("#checklist-btn");
    await page.waitForSelector("#checklist .item");
    const persisted = await page.evaluate(() => document.querySelector('#checklist .item button[data-result="pass"]').classList.contains("sel-pass"));
    await page.click("#export-results");
    await page.waitForTimeout(100);
    const exported = await page.evaluate(() => document.getElementById("export-output").value);
    let parsed = null; try { parsed = JSON.parse(exported); } catch {}
    R.check("checklist-persist-export", n >= 10 && persisted && parsed && parsed.checks.length === n && parsed.checks[0].result === "pass", { items: n, persisted });
    await page.screenshot({ path: path.join(SHOTS, `${name}-06-checklist.png`) });
    await page.evaluate(() => localStorage.clear());
    await page.click("#checklist-close");
  }

  // ---------- (f) big file performance ----------
  const insertLoop = async (lineNo) => page.evaluate(async (lineNo) => {
    const v = __cm.view; const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const pos = v.state.doc.line(Math.min(lineNo, v.state.doc.lines)).to;
    v.dispatch({ selection: { anchor: pos }, scrollIntoView: true }); await raf();
    const chars = "สวัสดี abc123 ผู้ใช้ ".repeat(20).slice(0, 200);
    const t = performance.now(); let max = 0; const per = [];
    for (let i = 0; i < 200; i++) { const s = performance.now(); v.dispatch(v.state.replaceSelection(chars[i]), { scrollIntoView: true, userEvent: "input.type" }); const d = performance.now() - s; per.push(d); max = Math.max(max, d); }
    const dispatchMs = performance.now() - t; await raf(); const toPaint = performance.now() - t;
    per.sort((a, b) => a - b);
    const ok = v.state.doc.sliceString(v.state.selection.main.head - 200, v.state.selection.main.head) === chars;
    return { insert200DispatchMs: +dispatchMs.toFixed(1), insert200ToPaintMs: +toPaint.toFixed(1), maxSingleDispatchMs: +max.toFixed(2), p50SingleDispatchMs: +per[100].toFixed(2), parsedWholeDoc: __cm.parsed(), noLang: __cm.noLang, ok };
  }, lineNo);
  {
    await openEditor(page);
    R.metrics.smallDocInsert = await insertLoop(20);
    R.note("small doc insert 200 chars: " + JSON.stringify(R.metrics.smallDocInsert));
    const t0 = Date.now();
    await openEditor(page, "?big=1");
    const loadMs = Date.now() - t0;
    const insertEarly = await insertLoop(10000);
    await page.waitForFunction(() => __cm.parsed(), null, { timeout: 15000 }).catch(() => {});
    const parseWaitMs = Date.now() - t0 - loadMs;
    const insertParsed = await insertLoop(10000);
    R.metrics.bigInsertEarly = insertEarly; R.metrics.bigInsertParsed = insertParsed; R.metrics.bigParseWaitMs = parseWaitMs;
    const m = await page.evaluate(async () => {
      const v = __cm.view; const EV = __cm.EditorView;
      const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = { lines: v.state.doc.lines, docLength: v.state.doc.length, createMs: __cm.createMs };
      let t;
      // scroll to end via scrollTop
      t = performance.now(); v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight; await raf();
      out.scrollToEndScrollTopMs = +(performance.now() - t).toFixed(1); out.viewportToAfterScroll = v.viewport.to;
      // back to top, then scrollIntoView(docEnd)
      v.scrollDOM.scrollTop = 0; await raf();
      t = performance.now(); v.dispatch({ effects: EV.scrollIntoView(v.state.doc.length) }); await raf();
      out.scrollToEndEffectMs = +(performance.now() - t).toFixed(1); out.lastLineRendered = v.viewport.to === v.state.doc.length;
      // jump to top with cursor
      t = performance.now(); v.dispatch({ selection: { anchor: 0 }, scrollIntoView: true }); await raf(); out.jumpToTopMs = +(performance.now() - t).toFixed(1);
      // 20 wheel-like scroll steps of one screen each, measure frame times
      const frames = []; let last = performance.now();
      for (let i = 0; i < 30; i++) { v.scrollDOM.scrollTop += v.scrollDOM.clientHeight; await new Promise(r => requestAnimationFrame(r)); const now = performance.now(); frames.push(now - last); last = now; }
      frames.sort((a, b) => a - b); out.pageScrollFrameMsP50 = +frames[15].toFixed(1); out.pageScrollFrameMsMax = +frames[29].toFixed(1);
      out.domLinesRendered = v.contentDOM.querySelectorAll(".cm-line").length;
      out.perfMemoryMB = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
      return out;
    });
    // typing through the real input path (CDP keyboard events), 200 chars
    await page.evaluate(() => { const v = __cm.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(15000).to }, scrollIntoView: true }); });
    await page.waitForTimeout(100);
    const typed = "ผู้ใช้ hello น้ำ 123 ".repeat(20).slice(0, 200);
    const tt = Date.now(); await page.keyboard.type(typed); m.keyboardType200Ms = Date.now() - tt;
    m.keyboardType200Ok = (await page.evaluate((n) => { const v = __cm.view; const h = v.state.selection.main.head; return v.state.doc.sliceString(h - n, h); }, typed.length)) === typed;
    await page.keyboard.press("Control+End"); await page.waitForTimeout(100);
    m.ctrlEndAtDocEnd = await page.evaluate(() => __cm.sel().head === __cm.view.state.doc.length);
    const metrics = await cdp.send("Performance.getMetrics");
    const get = k => metrics.metrics.find(x => x.name === k)?.value;
    m.cdpJSHeapUsedMB = +(get("JSHeapUsedSize") / 1048576).toFixed(1); m.cdpJSHeapTotalMB = +(get("JSHeapTotalSize") / 1048576).toFixed(1);
    m.cdpDomNodes = get("Nodes"); m.cdpLayoutCount = get("LayoutCount"); m.pageLoadMs = loadMs;
    m.perfMemoryMB = await page.evaluate(() => performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null);
    R.metrics.big = m;
    R.check("f-big-file-load", m.lines === 20000, { lines: m.lines, createMs: +m.createMs.toFixed(0), pageLoadMs: loadMs });
    // Note: CM's background parser only parses ~100k chars past the viewport, so parsedWholeDoc stays false by design; "secondRun" is after a 15 s wait.
    R.check("f-big-insert-200", insertEarly.ok && insertParsed.ok && insertParsed.p50SingleDispatchMs < 16.7 && m.keyboardType200Ok, { firstRun: insertEarly, secondRun: insertParsed, waitedMs: parseWaitMs, keyboardType200Ms: m.keyboardType200Ms, threshold: "p50 single dispatch < 16.7 ms (one 60 Hz frame)" });
    // same without a syntax parser
    await openEditor(page, "?big=1&nolang=1");
    R.metrics.bigInsertNoLang = await insertLoop(10000);
    R.note("big doc, no language parser, insert 200 chars: " + JSON.stringify(R.metrics.bigInsertNoLang));
    await openEditor(page, "?big=1"); await page.waitForFunction(() => __cm.parsed(), null, { timeout: 15000 }).catch(() => {});
    R.check("f-big-scroll-to-end", m.lastLineRendered && m.scrollToEndEffectMs < 1000, { scrollToEndScrollTopMs: m.scrollToEndScrollTopMs, scrollToEndEffectMs: m.scrollToEndEffectMs, pageScrollFrameMsP50: m.pageScrollFrameMsP50, pageScrollFrameMsMax: m.pageScrollFrameMsMax, domLinesRendered: m.domLinesRendered });
    R.note(`memory (big file, after edits+scroll): JS heap used ${m.cdpJSHeapUsedMB} MB (total ${m.cdpJSHeapTotalMB} MB, performance.memory ${m.perfMemoryMB} MB), DOM nodes ${m.cdpDomNodes}`);
    await page.screenshot({ path: path.join(SHOTS, `${name}-07-big-file.png`) });
  }

  await context.close();
  fs.writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify(R, null, 2));
  return R;
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--enable-precise-memory-info"] });
const results = [];
try {
  results.push(await runProfile(browser, "desktop", { viewport: { width: 1280, height: 800 } }, false));
  results.push(await runProfile(browser, "pixel7", { ...devices["Pixel 7"] }, true));
} finally { await browser.close(); }
const summary = results.map(r => ({ profile: r.profile, pass: r.checks.filter(c => c.ok).length, fail: r.checks.filter(c => !c.ok).length, failed: r.checks.filter(c => !c.ok).map(c => c.id) }));
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(RESULTS, "summary.json"), JSON.stringify(summary, null, 2));
