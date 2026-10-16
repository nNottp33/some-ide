# Spike: แผนที่ API ภายใน VS Code 1.141.0 สำหรับ `terminalContrib/blocks`

วันที่: 2026-10-16 · แหล่ง: source ของ microsoft/vscode ที่ tag 1.141.0 (อ่านอย่างเดียว) · ทุก path อ้างอิงจาก `src/vs/`

จุดประสงค์: ก่อนเขียน contribution "blocks" (แสดงคำสั่งที่จบแล้วเป็นรายการเหนือ xterm ที่ย่อขนาดลง)
ต้องรู้ว่า API ภายในที่แผนอ้างถึง (`ICommandDetectionCapability`, `ITerminalCommand.getOutput()`) มีอยู่จริง
หน้าตาเป็นอย่างไร และเปราะตรงไหน ผลสรุป: **ข้อสมมติของแผนใช้ได้ แต่มีข้อควรระวัง 10 ข้อ (ท้ายเอกสาร) ที่ต้องออกแบบรองรับตั้งแต่ต้น**

## 1. Command detection API — `platform/terminal/common/capabilities/capabilities.ts`

- `ICommandDetectionCapability` (บรรทัด 213–268): `promptInputModel` (215), `readonly commands: readonly ITerminalCommand[]` (216),
  `executingCommand` (218), `executingCommandObject` (219), `cwd` (222), `hasRichCommandDetection` (223), `currentCommand` (224);
  events `onCommandStarted`, `onCommandFinished`, `onCommandExecuted: Event<ITerminalCommand>` (225–227),
  `onCommandInvalidated: Event<ITerminalCommand[]>` (228), `onCurrentCommandInvalidated` (229), `onSetRichCommandDetection` (230);
  `getCommandForLine(line)` (241)
- `IBaseTerminalCommand` (299–315): `command`, `commandLineConfidence`, `isTrusted`, `timestamp`, `duration`, `id`, `cwd`, `exitCode`, `executedX`, `startX`
- `ITerminalCommand` (317–332): `promptStartMarker?`, `marker?`, `endMarker?`, `executedMarker?`, `wasReplayed?`, `extractCommandLine()`,
  `getOutput(): string | undefined`, `getOutputMatch(outputMatcher)`, `hasOutput()`, `getPromptRowCount()`, `getCommandRowCount()`
- implementation: `commandDetection/terminalCommand.ts` — `getOutput` 123–155, `hasOutput` 208–218, `isFullTerminalCommand` 472
- ไม่มี `onCurrentCommandChanged` ใน `src/vs` (ชื่อที่แผนรอบก่อนใช้ผิด)

## 2. การเข้าถึง capability จาก instance

- `IBaseTerminalInstance.capabilities: ITerminalCapabilityStore` — `workbench/contrib/terminal/browser/terminal.ts:452`
- store (capabilities.ts 60–113): `onDidAddCapability` / `onDidRemoveCapability` / `onDidChangeCapabilities`,
  `onDidAddCommandDetectionCapability` (82), `createOnDidAddCapabilityOfTypeEvent(type)` (95), `has` (107), `get<T>` (112) — ไม่มี `onDidAddCapabilityType`
- ตัวจริงคือ `TerminalCapabilityStoreMultiplexer` (`terminalInstance.ts:216`); store ของ shell integration ถูกเพิ่มที่ 948

## 3. การลงทะเบียน contribution

- `terminalExtensions.ts`: `ITerminalContributionContext { instance, processManager, widgetManager }` (12–16),
  `registerTerminalContribution(id, ctor, canRunInDetachedTerminals = false)` (42–47)
- `ITerminalContribution` (`terminal.ts:54–60`): `layout?(xterm, dimension)`, `xtermOpen?`, `xtermReady?`, `handleMouseEvent?`
- สร้างผ่าน DI ใน `terminalInstance.ts:650–677`; `xtermReady` ยิงที่ 667–671, `xtermOpen` ที่ 1130–1141, `layout` ที่ 2045–2056
- แม่แบบที่เล็กที่สุด: `terminalContrib/commandGuide/` (2 ไฟล์) — class ที่ `browser/terminal.commandGuide.contribution.ts:22–90`,
  `registerTerminalContribution(...)` ที่ 92; import ใน `terminal/terminal.all.ts:23`; settings กระจายผ่าน `terminalContribExports.ts:14,79`
  ซึ่ง `terminalConfiguration.ts:18,712` ใช้
- precedent ของการ import CSS: `terminal.stickyScroll.contribution.ts:6`

## 4. Decorations / command guide (UI ที่ผูกกับ marker อยู่แล้ว)

- `decorationAddon.ts`: wiring ต่อ capability ที่ 85–108 และ 220–277; seed จาก `capability.commands` (230–232);
  ฟัง `onCommandFinished` (233–253; ข้ามถ้า cursor อยู่เหนือ `promptStartMarker`) และ `onCommandInvalidated` (255–266);
  วางตำแหน่ง (284–333) ด้วย `this._terminal.registerDecoration({ marker, overviewRulerOptions })` + `decoration.onRender(el => …)`
- `markNavigationAddon.ts`: `showCommandGuide` (283–330) ใช้ `registerMarker(-cursorY + line - baseY + offset)` (242–253), ยอมแพ้เมื่อเกิน 200 บรรทัด; `revealCommand` 255–268
- `IMarkTracker`: `terminal.ts:384–402`
- `IXtermTerminal` (`terminal.ts:1405–1585`): `markTracker` 1410, `shellIntegration` 1415, `decorationAddon` 1417, `getRangeAsVT` 1499,
  `scrollToLine` 1545, `getBufferReverseIterator` 1566, `getContentsAsText` 1572
- **`raw` ไม่อยู่ใน `IXtermTerminal`** — hook ต่าง ๆ ได้รับ `IXtermTerminal & { raw: RawXtermTerminal }`; `ctx.instance.xterm` คือ `XtermTerminal` ตัวจริง
  (`terminal.ts:1097`; `raw` ที่ `xtermTerminal.ts:120`); `instance.registerMarker` ที่ `terminal.ts:1176`

## 5. Layout — จะเบียด xterm ให้เหลือที่ด้านบนสำหรับรายการ block ได้อย่างไร

- DOM: container > `.terminal-wrapper` (= `instance.domElement`, `terminalInstance.ts:424–425`) > `.terminal-xterm-host` (1117–1119)
  > `.xterm` (`raw.element`) > `.xterm-viewport` / `.xterm-screen` > `.terminal-widget-container` (`widgetManager.ts:13–17`)
- CSS (`terminal/browser/media/terminal.css`): `.xterm` เป็น `position:absolute; bottom:0` (88–95); wrapper และ host `height:100%` (68–73, 147–150)
- เส้นทางคำนวณขนาด: `layout()` (2020–2057) → `_evaluateColsAndRows` (733–760) → `_getDimension` (774–791) → `_resize` (2059–2101)
  ซึ่ง resize ทั้ง xterm และ PTY; `_getDimension` หัก paddingTop/Bottom ของ `.xterm` (786)
- **hook `layout` ของ contribution ถูกเรียกหลัง `_resize` ด้วย dimension เดิม จึงย่อ terminal เองไม่ได้** ทางเลือกที่ไม่ต้องแก้ core:
  1. `instance.setOverrideDimensions({ rows })` (2193–2205) — getter `rows` คืน `min(override, _rows)` (259–270) แต่ extension pseudoterminal ก็ใช้ override นี้ (1574)
  2. เพิ่ม padding ให้ `.xterm` แล้วเรียก `instance.layout(lastDim)` ซ้ำ
  ทั้งสองวิธีทำให้ `.xterm` ที่ยึดขอบล่างเหลือที่ว่างด้านบนของ wrapper สำหรับรายการ block
- precedent ของการเพิ่ม DOM ใกล้ terminal: chat ต่อ `.terminal-inline-chat` เข้า `domElement` (`terminalChatController.ts:86`; `terminalChatWidget.ts:136–138`)
  และเลื่อน wrapper ด้วย `style.bottom` (316–326) = overlay ไม่ใช่ resize; sticky scroll ต่อ `.terminal-sticky-scroll` เข้า `raw.element.parentElement`
  (`terminalStickyScrollOverlay.ts:399–400`)

## 6. precedent ที่ใกล้ที่สุด

- Sticky scroll: เปิดเมื่อมี CommandDetection + `hasRichCommandDetection` + element (`terminalStickyScrollContribution.ts:131–135`); ตอบสนอง capability add/remove (83–96)
  และ `onSetRichCommandDetection` (115); overlay วาดใหม่จาก `raw.onScroll`, `onLineFeed`, `onCursorMove` และ viewport scroll (184–198),
  ใช้ `getCommandForLine(viewportY)` (239) และเขียน VT ลง xterm ตัวที่สอง (324–347); ซ่อนใน alt buffer ผ่าน `buffer.onBufferChange` (90–92)
- Suggest: `runAndSubscribe(capabilities.onDidChangeCapabilities)` แล้วฟัง `promptInputModel.onDidChangeInput` / `onDidFinishInput` (`terminalSuggestAddon.ts:210–230`)
- QuickFix: `onCommandFinished` (`quickFixAddon.ts:187`) + `getOutputMatch` (371)

## 7. OSC 633 และ alt buffer

- `ShellIntegrationOscPs` export แล้ว (`shellIntegrationAddon.ts:39–55`; `VSCode = 633` ที่ 48)
- `VSCodeOscPt` เป็น const enum **ที่ไม่ export** (103; `CommandLine = 'E'` ที่ 169) — contribution import ไม่ได้
- handler ลงทะเบียนที่ 370, parse ที่ 473–512; `E` จัดการที่ 501–511: `setCommandLine(deserializeVSCodeOscMessage(arg0), arg1 === this._nonce)`
- alt buffer: ไม่มี event บน instance/`IXtermTerminal`; `terminalInstance.ts:887` subscribe `raw.buffer.onBufferChange` เพื่ออัปเดต context key
  `altBufferActive` (1305–1306; `terminalContextKey.ts:91`) — contribution ต้อง subscribe `raw.buffer.onBufferChange` เอง (overlay 90; `strategyHelpers.ts:70`)

## 8. ผู้ใช้ `getOutput()` ใน tree (ยืนยันว่าเป็น API ที่ใช้จริง)

`terminalRunRecentQuickPick.ts:281`, `decorationAddon.ts:481,491`, `terminal.clipboard.contribution.ts:219,240`, `chatContext.ts:404,432`,
`getTerminalLastCommandTool.ts:109`, `richExecuteStrategy.ts:207`, `basicExecuteStrategy.ts:263`, `mainThreadTerminalService.ts:252`

พฤติกรรมเมื่อ scrollback ถูกตัด: ไม่เช็ก `isDisposed`; marker ที่ dispose แล้วมี line = -1 — ถ้า marker ทั้งคู่หายจะคืน `undefined` (130–132)
แต่ถ้าหายเฉพาะ `executedMarker` ลูปเริ่มที่ -1 ข้ามบรรทัดที่หาย และ**คืนเฉพาะส่วนท้ายที่เหลือโดยไม่บอก** ทางเลือกที่ปลอดภัยกว่า:
`getCommandOutputSnapshot` (`chatTerminalCommandMirror.ts:229–293`) จัดการ marker ที่ dispose แล้ว; `getContentsAsText` โยน error เมื่อ end marker ถูก dispose (`xtermTerminal.ts:396`)

## 9. Build และการลงทะเบียน

- `workbench.common.main.ts:334` import `terminal.all.js`; desktop/web main import common (`workbench.desktop.main.ts:15`, `workbench.web.main.ts:16`)
- contrib ใหม่ต้องการ import 1 บรรทัดใน `terminal.all.ts` (16–39); settings เพิ่มใน `terminalContribConfiguration` (`terminalContribExports.ts:74–87`) หรือลงทะเบียนแยก
- ESLint: terminalContrib import ได้เฉพาะ `terminal/` และตัวเอง (`eslint.config.js:1900–1912`); private member ต้องขึ้นต้นด้วย `_` (2487)

## 10. จุดเปราะของสมมติฐาน "blocks = ICommandDetectionCapability + getOutput()" และวิธีรับมือ

| # | ข้อเท็จจริง | ผลต่อการออกแบบ blocks |
| --- | --- | --- |
| 1 | เฉพาะ `onCommandFinished` ส่ง `ITerminalCommand` จริง; `onCommandStarted` ส่ง `{marker}` ปลอม, `onCommandExecuted` ส่ง `PartialTerminalCommand` ที่ cast (`commandDetectionCapability.ts:92–96, 492, 564, 580`) | สร้าง block สมบูรณ์เมื่อ finished เท่านั้น; ระหว่างรันแสดง "live block" จาก xterm |
| 2 | `getOutput` อ่าน `buffer.active` (`terminalCommand.ts:136`) จึงผิดขณะ alt buffer ทำงาน | snapshot output ทันทีตอน finished |
| 3 | `getOutput` เป็น plain text ไม่มี ANSI | ใช้ `getRangeAsVT` สำหรับสี; precedent `DetachedTerminalCommandMirror` (`chatTerminalCommandMirror.ts:299`) |
| 4 | scrollback default 1000 บรรทัด (`terminalConfiguration.ts:330–332`) และ `commands` ไม่เคยถูกตัด | เก็บ snapshot ของ block เอง อย่าพึ่ง buffer ย้อนหลัง |
| 5 | Clear Terminal เรียก `raw.clear()` (`xtermTerminal.ts:787–794`) dispose marker **โดยไม่ยิง** `onCommandInvalidated` | ติดตาม `IMarker.onDispose` |
| 6 | `scrollOnEraseInDisplay` เป็น true (`xtermTerminal.ts:271`) ทำให้ `clear`/CSI 2J ไม่ invalidate commands | เช่นเดียวกับข้อ 5 |
| 7 | Enter บน prompt ว่างได้ command `''` (`terminalCommand.ts:336–342`); `timestamp` คือเวลาจบ ไม่ใช่เริ่ม (352) | กรอง block ว่าง; เก็บเวลาเริ่มเองจาก `onCommandStarted` |
| 8 | ตอน reconnect commands ถูก replay ผ่าน `onCommandFinished` พร้อม `wasReplayed` (497–504); capability อาจมาช้า | seed จาก `commands` แบบ `decorationAddon.ts:230` และติดธง replayed |
| 9 | ไม่มี shell integration → มีแค่ `PartialCommandDetection` (`IMarker[]`) ไม่มี blocks; heuristics บน Windows อาจ invalidate (182–187) | ตกไปแสดง raw grid; cmd.exe ไม่มี blocks ตามแผน |
| 10 | การย่อ rows จะ resize PTY ด้วย | คืนขนาดเต็มเมื่อ alt buffer ทำงาน (TUI) |

สรุป: ไปต่อได้ โดยให้ contribution เป็นชั้นบาง ๆ ที่ (ก) ฟัง `onCommandFinished` + `onCommandInvalidated` + `IMarker.onDispose`,
(ข) snapshot ทั้ง plain text และ VT ตอนจบคำสั่ง, (ค) ใช้ `setOverrideDimensions` หรือ padding + `layout()` เพื่อเบียด xterm,
(ง) ฟัง `raw.buffer.onBufferChange` เพื่อสลับโหมด TUI และ (จ) ลงทะเบียนด้วย import บรรทัดเดียวใน `terminal.all.ts` + settings ใน `terminalContribExports.ts`
