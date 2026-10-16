# Spike: CodeMirror 6 เป็น editor ของแอปมือถือ — ข้อความไทย, extra keys, ประสิทธิภาพ

**สรุปภาษาไทย (2026-10-16):** CodeMirror 6 **ใช้ได้** สำหรับแอปมือถือ โดยมีเงื่อนไข
- ต้องมี extension เล็ก ๆ (`thaiWords()`, ~190 บรรทัด, ใช้ `Intl.Segmenter('th')`) เพราะค่าเริ่มต้นของ CodeMirror มองคำไทยทั้งช่วงเป็นคำเดียว
  และแย่กว่านั้นคือตัดคำกลางวรรณยุกต์ (`ผู้` → `ผู`) — extension นี้ทำให้ดับเบิลคลิก, Ctrl+←/→ และ Ctrl+Backspace ทำงานทีละคำไทยถูกต้อง
- ทดสอบอัตโนมัติบน Chromium ผ่าน 33/33 ทั้ง desktop และ Pixel 7 (touch emulation): พิมพ์ไทยอ่านกลับตรง, extra-keys bar, การย่อ viewport เมื่อคีย์บอร์ดขึ้น
- ไฟล์ 20,000 บรรทัด: สร้าง editor 45–56 ms, พิมพ์ทีละตัว p50 5–10 ms (ต้นทุนจาก parser ของ Lezer; ไม่มี parser เหลือ ~1 ms), เลื่อนลงท้ายไฟล์ 21–33 ms, heap 25–30 MB
- bundle 170 kB gzip (ลดได้อีก ~40–50 kB ถ้า lazy-load parser ภาษา)
- **สิ่งที่ทดสอบที่นี่ไม่ได้และต้องทำบนเครื่องจริง:** การประกอบคำของ IME (Gboard/iOS), selection handles, long-press, 120 Hz, และ WKWebView ทั้งหมด —
  harness มี checklist 17 ข้อในตัวสำหรับทดสอบบนโทรศัพท์ (เปิดผ่าน LAN ด้วย `npm run dev -- --host`)
- ข้อสังเกต: Backspace บน Android UA ลบทั้ง cluster (ดี) ส่วน desktop ลบทีละ code point — เป็นพฤติกรรมของเบราว์เซอร์ ต้องยืนยันบนเครื่อง

harness จะถูกย้ายเข้า repo เป็น `apps/mobile-spike` (ตอนนี้อยู่ใน scratchpad ของ session) รายงานฉบับเต็มภาษาอังกฤษอยู่ด้านล่าง

---

# P0 spike: CodeMirror 6 as the phone editor (Thai text editing, touch extras, performance)

Date: 2026-10-16. Location: `scratchpad/cm6-thai-spike/` (self-contained Vite + TypeScript harness, own `package.json`; nothing in the main repo was touched).

## 1. Recommendation

**CodeMirror 6 is fit for the phone editor: YES, with caveats.**

- Everything that can be verified in Chromium passed on both the desktop profile (1280x800) and the Pixel 7 touch-emulation profile, 33/33 checks each (see section 4).
- Thai word navigation and selection need a small extension (`src/thaiWords.ts`, ~190 lines) built on `Intl.Segmenter('th', { granularity: 'word' })`. Without it CodeMirror's default double-click / Ctrl+Arrow treat a whole run of Thai letters as one word and, worse, its default `wordAt` *splits inside* a Thai word at a combining tone mark (`ผู้` -> `ผู`), because U+0E48-0E4B are categorised as non-word characters. The extension is reusable as `thaiWords()` and plugs into `EditorView.mouseSelectionStyle` and a high-precedence keymap, so no fork of CodeMirror is needed.
- Performance is fine for normal files and acceptable for a 20,000-line TypeScript file; the one real cost is the incremental syntax parser (Lezer) on every keystroke in a huge file (5-15 ms per keystroke on this Xeon vs ~1.2 ms without a parser). On a mid-range phone expect roughly 2-4x that, so very large files should either be opened with a lighter highlighter or accept some keystroke latency. Scrolling is viewport-virtualised (~80 DOM lines rendered for 20k lines) and stayed at one frame per screen-page scroll.
- The real risks are not in CodeMirror but in the WebView: IME composition (Gboard/iOS Thai keyboards), native selection handles, long-press menus and 120 Hz scrolling cannot be tested in headless Chromium and must be checked on devices with the built-in checklist (section 6). CodeMirror 6 has explicit Android/iOS composition handling code paths (it hands composition and Backspace to the browser on Android and reconciles the DOM afterwards), which is the right design for Thai IMEs, but it is exactly that path that needs device verification.
- Tauri 2 caveat: on Android the WebView is the system Chromium WebView (close to what was emulated here); on iOS it is WKWebView (WebKit) which could not be tested in this environment at all. The iOS keyboard/visualViewport behaviour (page scrolls instead of resizing, `offsetTop` changes) is handled in the harness but unverified.

## 2. Exact versions used

| Package | Version |
|---|---|
| @codemirror/view | 6.43.14 |
| @codemirror/state | 6.7.6 |
| @codemirror/language | 6.13.1 |
| @codemirror/commands | 6.11.1 |
| @codemirror/search | 6.7.2 |
| @codemirror/lang-javascript | 6.2.5 |
| @codemirror/lang-python | 6.2.1 |
| @codemirror/theme-one-dark | 6.1.3 |
| vite | 8.3.4 |
| typescript | 7.0.2 |
| playwright (from the main repo's node_modules) | 1.64.0 |
| Chromium (Playwright build 1194, headless, `/opt/pw-browsers/chromium`) | 156.0.8078.4 |
| Node / npm | 22.22.0 / 10.9.4 |
| Test machine | 4x Intel Xeon @ 2.80 GHz, 16 GB RAM, Linux container (no GPU) |

Not available here: WebKit/WKWebView, Android WebView, real IMEs, a real touch screen, a 120 Hz display.

## 3. What was built (harness)

Files (all under `scratchpad/cm6-thai-spike/`):

- `index.html`, `src/style.css` - mobile layout: 44 px toolbar, editor fills the rest, 44 px extra-keys bar at the bottom. `#app` is `position: fixed` with `height: var(--vvh)` and `top: var(--vv-top)` which JS keeps in sync with `window.visualViewport` (`resize` + `scroll` events), so the layout shrinks when a soft keyboard appears and the keys bar sits directly above the keyboard. The `viewport` meta uses `interactive-widget=resizes-content` (Chrome 108+) so Android resizes the layout viewport too. Note: CodeMirror's base theme sets `.cm-editor { position: relative !important }`, so the editor must be sized with `height: 100%`, not `position: absolute; inset: 0` (first attempt bled lines over the keys bar).
- `src/main.ts` - editor setup: `lineNumbers`, `history`, `bracketMatching`, `defaultKeymap` + `historyKeymap` + `searchKeymap` + `indentWithTab`, `search({ top: true })`, `highlightActiveLine`, `highlightSelectionMatches`, `rectangularSelection`, TS or Python language (`?lang=py`), `oneDark` in dark colour scheme, `autocorrect/autocapitalize/spellcheck` off on the content element. Query flags: `?big=1` (20,000-line generated TS), `?wrap=1`, `?nolang=1` (no parser, for perf comparison). `window.__cm` exposes the view and helpers for the tests.
- `src/samples.ts` - TS and Python samples whose comments/strings contain สวัสดี, น้ำ, ผู้ใช้, กรุงเทพมหานคร, ป้า, mixed Thai/English/digits; `bigSample()` generator.
- `src/thaiWords.ts` - the reusable extension `thaiWords()`: `thaiWordAt`, `thaiWordBoundary`, commands `cursorThaiWordLeft/Right`, `selectThaiWordLeft/Right`, `selectThaiWord`, `deleteThaiWordBackward/Forward`, keymap `Ctrl/Alt+Left/Right` (+Shift to select, `Ctrl/Alt+Backspace/Delete` to delete a word) and a `mouseSelectionStyle` for `detail == 2` (double-click selects one Segmenter word, drag extends word-wise). Segments per line are cached. Falls back to whitespace splitting if `Intl.Segmenter` is missing (it is present in Chromium >= 87, WebKit >= 14.1).
- `src/extraKeys.ts` - extra-keys bar: Tab, Esc, Ctrl, Alt, ←↑↓→, Home, End, Undo, Redo, Sel (select Thai word), Copy, Paste (async Clipboard API). Ctrl and Alt are sticky for the next key (bar key, or physical key via a `keydown` handler that re-dispatches through `runScopeHandlers`). Buttons `preventDefault()` on `pointerdown`/`mousedown` so focus (and the soft keyboard) stays in the editor. Tab/Esc are routed through CodeMirror's keymaps first (so Tab = `indentWithTab`, Esc closes the search panel / collapses selection).
- `src/checklist.ts` - "Device checklist" side panel: 17 manual checks with Pass/Fail/Skip buttons and a note field, persisted in `localStorage` (`cm6-thai-spike-checklist`), "Export results" writes JSON (device info + results) to a text box, the clipboard and a download.
- `tests/run.mjs` - Playwright script (desktop 1280x800 and `devices['Pixel 7']`), writes `results/<profile>.json`, `results/summary.json`, `results/run.log` and screenshots in `shots/`.

### How to launch for a phone on the same LAN

```
cd scratchpad/cm6-thai-spike
npm install              # already done here
npm run dev -- --host    # Vite prints a http://<LAN-IP>:5173 URL; open it on the phone
#   add ?big=1 for the 20k-line file, ?lang=py for Python, ?wrap=1 for wrapping
npm run build            # production bundle in dist/ (sizes below)
npm test                 # Playwright run (dev server must be running on :5173)
```
On the phone: tap "Checklist" in the toolbar, work through the items, then "Export results" (JSON is copied to the clipboard and downloaded). Clipboard API needs a secure context on real devices: plain `http://<LAN-IP>` is *not* secure, so for the Copy/Paste checks either use `vite --host --https` (needs a cert) or test inside the Tauri shell (`tauri://` / `https://tauri.localhost` are secure contexts).

## 4. Automated results on Chromium (Playwright)

Two profiles: **desktop** = 1280x800 mouse/keyboard; **pixel7** = `devices['Pixel 7']` (412x915 CSS px, DPR 2.625, `isMobile`, `hasTouch`, Android 14 UA). Result: **desktop 33/33 passed, pixel7 33/33 passed** (`results/summary.json`; per-check detail in `results/desktop.json`, `results/pixel7.json`, full log `results/run.log`).

### (a) Typing Thai and reading it back

| Check | desktop | pixel7 |
|---|---|---|
| `page.keyboard.type("สวัสดี น้ำ ผู้ใช้ 123 abc")` (25 code points, one key event per code point) then `doc.toString()` equals input | PASS, 211 ms | PASS, 169 ms |
| `page.keyboard.insertText("กรุงเทพมหานคร ป้า ✓")` (CDP `Input.insertText`, like an IME commit) equals input | PASS | PASS |
| CDP `Input.imeSetComposition` ส → สว → สวั → สวัส → สวัสด → สวัสดี, then commit | PASS, document got `สวัสดี`; CodeMirror saw `compositionstart` x1, `compositionupdate` x7, `compositionend` x1 | PASS, document correct, but **0 composition events** were observed under mobile emulation (Chromium inserted the final text directly) |
| Backspace after `สวัสดี` | removes one code point (`ี`) - CodeMirror's own `deleteCharBackward` path | removes the whole cluster `ดี` - with an Android UA CodeMirror lets the browser perform the deletion natively and reconciles afterwards |
| ArrowLeft over `ดี` | moves 1 code unit here (CM moves by its own cluster logic) | same |

**Important limitation:** Playwright cannot drive a real IME. `keyboard.type` sends one keydown/keyup per code point with `text` set, `insertText` is a single commit, and `Input.imeSetComposition` is Chromium's test hook, not Gboard/iOS. Real Thai keyboards send `beforeinput` with `insertCompositionText`, use `deleteSurroundingText`, and on Android report `key: "Unidentified"` / `keyCode 229`. The two Backspace behaviours above show that the code path genuinely differs per platform, so this is a **real-device item**. CodeMirror 6 has dedicated handling for both (`browser.android` composition/Backspace path, `browser.ios` quirks), which is encouraging but unverified here.

### (b) Double-click selects exactly the `Intl.Segmenter` word

Expected ranges were computed independently in Node with `new Intl.Segmenter('th', {granularity:'word'})` and compared with the editor selection after `page.mouse.dblclick` inside the word:

| Word clicked (inside) | selected (both profiles) | expected segment | CodeMirror default `wordAt` would give |
|---|---|---|---|
| กรุงเทพมหานคร (in `/** ชื่อเมือง: กรุงเทพมหานคร, ... */`) | กรุงเทพมหานคร | กรุงเทพมหานคร | กรุงเทพมหานคร (only because a space/comma bound it) |
| ผู้ใช้สามารถแก้ไข... (comment line 2) | ผู้ | ผู้ | **ผู** (breaks inside the word at the tone mark U+0E49) |
| น้ำ (`const water = "น้ำ"`) | น้ำ | น้ำ | น้ำ |

PASS x3 on both profiles. On pixel7 an emulated double-tap (`page.touchscreen.tap` x2) also selected กรุงเทพมหานคร because Chromium synthesises `mousedown` with `detail=2` from the taps; on a real phone a double-tap runs the OS word selection (native handles) and CodeMirror only syncs the resulting DOM selection - Android's native word break is ICU dictionary-based too, so it should agree, but this is a device check.

### (c) Ctrl+Right moves by Thai word

From the start of `ผู้ใช้สามารถแก้ไขไฟล์นี้ได้จากโทรศัพท์`, eight `Control+ArrowRight` presses visited: `ผู้ | ใช้ | สามารถ | แก้ไข | ไฟล์ | นี้ | ได้ | จาก` (heads 70, 73, 79, 84, 88, 91, 94, 97; each is an `Intl.Segmenter` boundary). CodeMirror's default would treat the entire run `ผู้ใช้สามารถแก้ไขไฟล์นี้ได้จากโทรศัพท์` as one word. Also PASS: `Control+ArrowLeft` back to a boundary, `Shift+Control+ArrowRight` selects `ผู้`, `Control+Backspace` deletes exactly `ใช้`. Identical on both profiles (the keymap uses `Ctrl-`/`Alt-` explicitly so it is platform independent).

### (d) Extra-keys bar

All PASS on both profiles (desktop via `click`, pixel7 via `tap`): Tab indents the line (`"  const greeting..."`) and **focus stays in the editor** (`document.activeElement === contentDOM`), Undo/Redo restore/reapply it, ←/→ move one position, ↓/↑ move a line, Home/End go to line bounds, **sticky Ctrl then → moves by one Thai word (`ผู้`) and the modifier clears afterwards**, Sel selects the Thai word at the caret, Copy then Paste through `navigator.clipboard` round-trips the text (clipboard permissions granted to the context), Esc closes the search panel opened with Ctrl+F.

### (e) Viewport shrink keeps the caret visible

Caret placed on the last visible line, then the viewport was shrunk to 45 % height (simulating a soft keyboard): desktop 800 → 360 px: caret moved from y 723 to y 276, editor bottom 316, keys bar bottom 360 = `innerHeight`. pixel7 839 → 378 px: caret y 768 → 294, editor bottom 334, keys bar bottom 378. PASS both. The in-page "KB sim" button (300 px keyboard via `--kb-sim`) also PASSes: keys bar bottom sits exactly at `innerHeight - 300` and the caret stays inside the editor. Mechanism: `visualViewport` `resize` → update `--vvh`/`--vv-top` → `requestMeasure` + `EditorView.scrollIntoView(head, { y: 'nearest', yMargin: 24 })`.

### (f) 20,000-line file (`?big=1`, 20,000 lines / ~0.75 MB TypeScript, Thai comments every 12 lines)

| Metric | desktop | pixel7 (same CPU, mobile UA/viewport) |
|---|---|---|
| `new EditorView` with the 20k-line doc | 56 ms | 45 ms |
| page load to editor ready (dev server, unbundled) | 402 ms | 353 ms |
| insert 200 chars at line 10,000, one `dispatch` per char, with TS parser (first run, parser still warming up) | 1615 ms total, p50 5.4 ms, max 32.8 ms per keystroke | 1745 ms, p50 6.9 ms, max 31.5 ms |
| same, second run after a 15 s wait | 1536 ms, p50 7.2 ms, max 33.8 ms | 2087 ms, p50 10.2 ms, max 18.6 ms |
| same, **no language parser** (`?nolang=1`) | 226 ms, p50 0.9 ms, max 5.1 ms | 272 ms, p50 1.2 ms, max 6.0 ms |
| baseline: same loop in the 33-line sample with parser | 541 ms, p50 2.3 ms | 523 ms, p50 2.3 ms |
| 200 chars via `page.keyboard.type` (includes CDP round trips) | 3921 ms (19.6 ms/char), text verified | 5537 ms (27.7 ms/char), text verified |
| scroll to end via `scrollDOM.scrollTop = scrollHeight` until painted | 21 ms | 28 ms |
| `EditorView.scrollIntoView(doc.length)` until last line rendered | 31 ms | 33 ms |
| 30 page-sized scroll steps, frame time p50 / max | 16.7 / 22.5 ms | 16.6 / 24.9 ms |
| DOM `.cm-line` elements rendered | 79 | 81 |
| JS heap used / total (CDP `Performance.getMetrics`), after edits + scrolling | 30.1 / 54.5 MB | 24.9 / 84.3 MB |
| `performance.memory.usedJSHeapSize` | 40.5 MB | 34.5 MB |
| Ctrl+End lands on `doc.length` | PASS | PASS |

Reading: rendering is virtualised (80 lines in the DOM for 20k), scrolling to the end is a few tens of ms, memory is modest. The keystroke cost in a huge file is dominated by the Lezer incremental re-parse that `@codemirror/language` does synchronously (up to 20 ms budget) on every change: 5-10 ms p50 vs ~1 ms without a parser. `syntaxTreeAvailable(doc.length)` never becomes true because CodeMirror only parses ~100k characters beyond the viewport (by design), so "waiting for the parse" does not help; the cost is per edit. For files under a few thousand lines it is 2-3 ms. The 60 Hz frame budget is met on this machine; a phone SoC will be slower, so for the mobile IDE: keep the default language setup for normal files, and consider a lighter mode (no parser / `StreamLanguage` / highlight only) above some size threshold, which the harness already allows testing with `?nolang=1`.

### (g) Production bundle (`vite build`, target es2022, minified)

| Asset | raw | gzip -9 |
|---|---|---|
| `dist/assets/index-*.js` (CodeMirror core + search + commands + TS/JS + Python parsers + one-dark + harness) | 497.9 kB | **170.1 kB** (Vite reports 174.3 kB) |
| `dist/assets/index-*.css` | 4.3 kB | 1.4 kB |
| `dist/index.html` | 1.2 kB | 0.6 kB |

For scale: `@lezer/javascript` is 81 kB and `@lezer/python` 44 kB unminified; language packages can be loaded lazily per file type to keep the initial bundle around 120-130 kB gzip.

### Screenshots (`shots/`)

`desktop-01-initial.png`, `desktop-01b-python-wrap.png`, `desktop-02-dblclick-selection.png` (น้ำ selected), `desktop-03-extra-keys.png`, `desktop-04-viewport-shrunk.png`, `desktop-05-kb-sim.png`, `desktop-06-checklist.png`, `desktop-07-big-file.png`, and the same eight for `pixel7-*`.

## 5. What passed / failed on Chromium

- PASS (both profiles): Thai typing via key events and insertText; CDP-driven composition commit; Thai-aware double-click (3 words), Ctrl/Alt+Arrow, Shift-select, Ctrl+Backspace; every extra key incl. sticky modifiers and clipboard; viewport-shrink and keyboard-simulation caret visibility; checklist persistence (localStorage survives reload) and JSON export; 20k-line load/edit/scroll within thresholds.
- Nothing failed in the final run. Two observations are worth flagging rather than counting as failures: (1) under the Android UA, Backspace deletes a whole Thai cluster because CodeMirror defers to the browser there; (2) CDP IME composition produced no composition events under mobile emulation. Both are emulation artefacts that only a real device resolves.
- Cosmetic: the desktop console logs a 404 for `/favicon.ico`. The first layout attempt (`position:absolute` on `.cm-editor`) was overridden by CodeMirror's `!important` and let lines overlap the keys bar; fixed with `height: 100%`.

## 6. What can only be verified on real devices (the in-page checklist)

Open the harness on the phone (section 3), tap **Checklist**, and record Pass/Fail with a note; **Export results** produces JSON with the device info (UA, screen, DPR, visualViewport, `Intl.Segmenter` availability).

1. Thai IME composition (Gboard Thai / iOS Thai keyboard): สวัสดี, น้ำ, ผู้ใช้, ป้า - marks attach correctly, nothing duplicated/dropped, no caret jumps during composition.
2. Composing inside an existing Thai word (caret in the middle of กรุงเทพมหานคร).
3. Backspace over Thai clusters (one code point vs whole cluster; document stays consistent with the screen).
4. Autocorrect / predictive text does not mangle code (`autocorrect`, `autocapitalize`, `spellcheck` are off).
5. Selection handles appear on long-press and dragging them updates the editor selection.
6. Double-tap selects one Thai dictionary word (native word break).
7. Long-press context menu (Cut/Copy/Paste/Select all) works.
8. Scroll vs select: one-finger drag scrolls and never starts a selection.
9. Smooth flick scrolling in `?big=1`, including on a 120 Hz display.
10. Soft keyboard keeps the caret line visible and the extra-keys bar sits directly above the keyboard (real `visualViewport` behaviour; iOS scrolls the page instead of resizing).
11. Extra keys do not dismiss the keyboard.
12. Sticky Ctrl/Alt with the soft keyboard (Gboard reports `Unidentified` keys, so Ctrl+letter may not work there; Ctrl+arrow keys on the bar do).
13. External Bluetooth keyboard: Ctrl+Arrow, Ctrl+Z/Y, Ctrl+F, Ctrl+Backspace, Thai layout typing.
14. Copy/Paste through the Clipboard API inside the WebView (permission prompt behaviour; needs a secure context).
15. Thai tone marks render fully in the monospace font (no clipping at `line-height: 1.6`) and the caret does not land between a consonant and its mark.
16. Landscape / rotation reflow.
17. Pinch zoom blocked or acceptable.

Also unverifiable here: WKWebView (iOS) in general, the Android System WebView version actually shipped on the test phones, and GPU-composited scrolling.

## 7. Caveats and follow-ups for the real implementation

- Ship `thaiWords()` as-is (it is self-contained) and also wire `selectThaiWord` to the "Select word" action. Consider using the same segmenter for search "whole word" matching.
- Decide a file-size threshold above which the Lezer parser is replaced by a lighter highlighter, after measuring the per-keystroke time on the target phones (`?big=1` vs `?big=1&nolang=1`).
- Do not enable `drawSelection()` on phones: it hides the native caret/selection and would lose the OS selection handles and magnifier.
- The extra-keys "Paste" relies on `navigator.clipboard.readText`, which needs a secure context and, on Android, a user gesture - keep the native long-press Paste as the fallback.
- Keep `interactive-widget=resizes-content` in the viewport meta for Android Chrome >= 108; on iOS rely on `visualViewport.offsetTop` (handled) and test it.
- Harness run time: the whole Playwright suite takes about 3 minutes per run (`npm test`).
