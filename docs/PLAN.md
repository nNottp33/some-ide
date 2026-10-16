# แผนผลิตภัณฑ์และสถาปัตยกรรม: some-ide → IDE แบบ VS Code + terminal แบบ Warp บนทุกแพลตฟอร์ม

| | |
| --- | --- |
| เอกสาร | Product / architecture plan (codename `some-ide`) |
| เวอร์ชัน | 1.0 — 2026-10-16 |
| สถานะ | ทางเลือกหลักตัดสินแล้ว (ดู §12) — รอเริ่ม P0 |
| ผู้อ่าน | นักพัฒนาที่จะลงมือสร้าง (solo หรือทีมเล็ก) |
| แหล่งข้อมูล | รอบวางแผนที่ 1 (desktop-only, 2026-10-09) และรอบที่ 2 (ทุกแพลตฟอร์ม + Warp terminal, 2026-10-11) พร้อมผล fact-check ของแต่ละรอบ (§13) |

---

## 1. สรุปสำหรับผู้บริหาร

- เป้าหมาย: เปลี่ยน `some-ide` (browser-only IDE, TypeScript ~5.4k บรรทัด) ให้เป็น IDE ที่ "เป็น VS Code จริง" บน desktop และมี terminal แบบ blocks อย่าง Warp บน Windows, macOS, Linux, iOS, Android และ web
- ทางเลือกที่เลือก (Option C, คะแนนเฉลี่ยจากกรรมการ 3 คน = 7.0/10 เทียบกับ A 6.7, B 5.1, D 3.6): **desktop = branded Code-OSS fork** (VS Code 1.141.0, MIT) + in-tree "blocks" terminal + Monaco command-input editor + BYOK AI; **mobile = Tauri 2 app** (CodeMirror 6 + DOM block terminal + Rust core); **somed = daemon ต่อผู้ใช้** บนเครื่องของผู้ใช้เองที่ถือ PTY/ไฟล์/git/LSP/DAP/agents; **web** = reh-web ที่ somed เสิร์ฟ ("Full") และ some-ide เดิม ("Lite")
- เหตุผลหลัก: เฉพาะ C เท่านั้นที่ทำให้ฝั่ง IDE เป็น VS Code จริง (extension host, DAP, tasks, settings UI, Open VSX) ภายใน ~3 เดือน solo โดยให้ Microsoft ดูแลครึ่ง IDE ส่วนเราดูแลเฉพาะ terminal, somed และ mobile client
- ข้อจำกัดที่เปลี่ยนไม่ได้: iOS ห้าม spawn child process และไม่มี JIT นอก WKWebView → terminal บน iOS เป็น remote (somed/SSH) + sandbox shell ที่ติดป้ายชัดเจนเสมอ; Android มี local terminal ได้ผ่าน forkpty + shell ที่ bundle เป็น `.so` (ไม่มี package manager ใน Play build)
- Roadmap: P0 spike/go-no-go 3–4 สัปดาห์ (แก้ bug 9 รายการของ some-ide ก่อน) → P1 Desktop + Android alpha 10–12 สัปดาห์ → P2 iOS + SSH + signing 8–10 สัปดาห์ → P3 AI agent + tablet Full workbench 10 สัปดาห์ → P4 debugging/1.0 10 สัปดาห์ → P5 optional; รวม ~10 เดือน solo ถึง 1.0 บวกภาษี upstream merge ถาวร 15–20%
- ความเสี่ยงอันดับต้น: contrib ของ blocks อิง VS Code terminal internals ที่ไม่ public; xterm.js ไม่รองรับ touch; App Store 2.5.2/4.2.7(e); somed เป็น remote code execution โดยธรรมชาติ (ต้องมี Ed25519 pairing + TLS ตั้งแต่ P1); คนเดียวดูแล 3 ผลิตภัณฑ์
- ต้นทุนที่ต้องเตรียม: Apple Developer Program (US$99/ปี), Windows OV certificate (~US$250–500/ปี, สั่งใน P1), Mac สำหรับ build iOS (ของตัวเองหรือ cloud runner) ก่อน P2
- โค้ดทั้งหมดเป็น open-core ภายใต้ MIT/Apache-2.0; ชื่อผลิตภัณฑ์เลือกก่อน P1 alpha (ห้ามมีคำว่า "VS Code", "Visual Studio", "Warp")
- สิ่งที่ fact-check ยืนยันไม่ได้และต้องตรวจเองก่อนทำสัญญา: ถ้อยคำนโยบาย Google Play เรื่อง dex/.so, กรณี Replit ถูกระงับ, Azure Trusted/Artifact Signing สำหรับประเทศไทย, Tailscale free tier, เงื่อนไข Open VSX สำหรับผลิตภัณฑ์เชิงพาณิชย์

---

## 2. เป้าหมายและขอบเขต

### 2.1 เป้าหมาย

1. **IDE parity กับ VS Code บน desktop** — ไม่ใช่ "คล้าย VS Code" แต่ใช้ workbench, extension host, DAP, tasks, settings UI และ TextMate ของ VS Code เอง (ผ่าน Code-OSS ซึ่งเป็น MIT) และติดตั้ง extension จาก Open VSX
2. **Terminal แบบ Warp** — คำสั่ง + output เป็น "block" ที่เลื่อน/คัดลอก/แชร์/รันซ้ำได้, command-input editor หลายบรรทัดพร้อม completion และ history, AI ช่วยแปลง natural language → command และอธิบาย error, shell integration สำหรับ bash/zsh/fish/pwsh และ SSH
3. **ทุกแพลตฟอร์ม** — Windows 10 1809+/11, macOS 11+, Linux (glibc 2.28+), iOS/iPadOS 16+, Android 8+ (minSdk 26, targetSdk 36) และ web
4. **Compute บนเครื่องของผู้ใช้เอง** — โทรศัพท์เป็น client ของ laptop/VPS/container ของผู้ใช้ผ่าน daemon `somed` หรือ SSH; ไม่มี hosted multi-tenant cloud
5. **ภาษาไทย** — UI ไทย/อังกฤษบน mobile ตั้งแต่แรก, Thai language pack สำหรับ desktop (vscode-loc ไม่มีภาษาไทย — ยืนยันแล้ว), การพิมพ์/เลือกข้อความไทยถูกต้องบนทุก editor
6. **Licensing สะอาด** — โค้ดทั้งหมด MIT/Apache-2.0; ห้ามคัดลอกโค้ดจาก Warp (AGPL), kitty/Ghostty shell scripts (GPLv3), Blink/Termux/mosh/iSH (GPL)

### 2.2 ในขอบเขต

- Desktop: branded Code-OSS distribution + `terminalContrib/{blocks,inputEditor}` + built-in extensions `some-ai`, `some-runner`, `some-remote`
- `somed`: PTY + blocks (persisted), fs/watch, ripgrep, git, LSP/DAP proxy, ACP agent host, workflows, settings sync, เสิร์ฟ reh-web
- Mobile (Tauri 2): explorer, CodeMirror 6 editor, search, quick input, blocks terminal (local บน Android / remote + sandbox บน iOS), git (libgit2), offline mirror + diff3 merge, sandbox runners
- Web: Full (reh-web ผ่าน somed) และ Lite (some-ide เดิม)
- Release engineering: CI สำหรับ 5 OS, signing/notarization, store compliance, upstream-merge playbook

### 2.3 นอกขอบเขต (อย่างน้อยถึง 1.0)

- Hosted multi-tenant cloud workspace (รอบที่ 1 ให้คะแนน 5.2 และเป็นภาระ ops/PDPA/ต้นทุน)
- Local shell บน iPhone/iPad (เป็นไปไม่ได้ตามกฎของ Apple)
- Package manager สำหรับ native binaries บน Android Play build (proot เฉพาะ sideload build ใน P5)
- GPU text rendering ระดับ Metal/wgpu แบบ Warp/Ghostty (ใช้ xterm.js WebGL ตามระดับ VS Code; ไม่อ้าง parity)
- Microsoft-only extensions (Pylance, cpptools, C# Dev Kit, Live Share, Remote-SSH/Containers/WSL) และ Microsoft Marketplace — แทนด้วย basedpyright, clangd, CodeLLDB, open-remote-ssh และ Open VSX
- Yjs live co-editing, first-party relay, iOS File Provider extension → P5 ตามความต้องการ

### 2.4 ผู้สร้างและข้อสมมติ

- นักพัฒนา solo (เต็มเวลา, ถนัด TypeScript, Rust บางส่วน) หรือทีม 3–5 คน; ตัวเลขระยะเวลาทั้งหมดเป็น solo เว้นแต่ระบุ
- ภาระถาวร: VS Code ออก stable ทุกสัปดาห์ (tag 1.137–1.141 ภายใน ~1 เดือน) → กัน 15–20% ของเวลาสำหรับ merge, SDK churn และ store compliance

---

## 3. ข้อจำกัดของแพลตฟอร์ม (hard constraints)

ข้อจำกัดเหล่านี้เป็นกฎของแพลตฟอร์ม ไม่ใช่ทางเลือกออกแบบ ทุกข้อมีแหล่งอ้างอิงใน §15

### 3.1 iOS / iPadOS

| ข้อจำกัด | ผลต่อการออกแบบ |
| --- | --- |
| แอป iOS **spawn child process ไม่ได้** (fork/exec/posix_spawn/system ถูกบล็อก; Apple DTS ยืนยันในกระทู้ 747499) | ไม่มี local shell, PTY, language server แบบ subprocess, git binary หรือ Node บน iPhone/iPad; terminal และ LSP ต้องเป็น remote (somed/SSH) หรือ in-process (WASM ใน WKWebView) |
| **ไม่มี JIT** สำหรับแอป third-party (JIT มีเฉพาะใน WebContent process ของ WKWebView; Apple ปฏิเสธ entitlement แม้ภายใต้ EU DMA) | JS/WASM engine ที่ bundle เอง (Node, V8, wasmtime) ทำงานแบบ interpreter เท่านั้น; JS/Pyodide ที่หนักต้องอยู่ใน WKWebView |
| **App Store 2.5.2**: ห้ามดาวน์โหลด/ติดตั้ง/execute โค้ดที่เปลี่ยนฟีเจอร์ (ยกเว้น educational ที่ source ต้องดู/แก้ได้); มีการบังคับใช้ในปี 2026 กับแอป vibe-coding | ไม่มี extension host หรือ VSIX execution บน iOS; ไม่มี pip/npm/apt; Pyodide ต้อง bundle ในแอปและปิด micropip/esm.sh; preview เปิดใน Safari; เตรียม build variant ที่ไม่มี runner ไว้เป็น fallback |
| **App Store 4.2.7(e)**: "Thin clients for cloud-based apps are not appropriate"; 4.2.7(a) ให้ remote-desktop mirror เชื่อมเครื่องของผู้ใช้เอง | แอปต้องมี offline editor + git (libgit2) + sandbox runners + SSH client จริง ๆ เพื่อไม่ใช่ thin client (รูปแบบเดียวกับ Blink/Termius/Code App) |
| iOS **suspend แอปหลัง background ~20–30 วินาที**; ไม่มี background socket ยาว ๆ | session, scrollback และ agent run ต้องอยู่ที่ somed แล้ว reattach/replay; ห้ามใช้ location keepalive hack |
| **ต้องใช้ Xcode 26 / iOS 26 SDK** ตั้งแต่ 28 เม.ย. 2026; ต้องมี Mac; CocoaPods trunk จะ read-only 2 ธ.ค. 2026 (ยืนยันแล้ว) | ต้องมี Mac (ของตัวเองหรือ cloud runner) ก่อน P2; ตรวจการย้าย Tauri iOS project ไป SwiftPM ใน P2 |
| Filesystem แบบ sandbox: เห็นเฉพาะ app container + โฟลเดอร์ที่ผู้ใช้ให้ผ่าน document picker / security-scoped bookmarks / File Provider | Files-app integration ผ่าน `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` (P2), document-picker bookmarks (P4), File Provider (P5) |
| ข้อมูลถาวรใน WebView storage ไม่น่าเชื่อถือ | ข้อมูลถาวรต้องอยู่ฝั่ง Rust (SQLite + ไฟล์) ไม่ใช่ IndexedDB ใน WKWebView |
| VPN ได้ครั้งละหนึ่งตัว (Network Extension) | Tailscale ชนกับ corporate VPN → ต้องมี plain SSH / relay เป็นทางเลือก |

### 3.2 Android

| ข้อจำกัด | ผลต่อการออกแบบ |
| --- | --- |
| **W^X** (targetSdk ≥ 29, SELinux `untrusted_app_29`): `execve()` ไฟล์ใน app data dir ถูกปฏิเสธ; เอกสาร Android 10 ระบุให้ "load only the binary code that's embedded within an app's APK" | shell ต้อง bundle เป็น `lib/arm64-v8a/libzsh.so` แล้ว exec จาก `nativeLibraryDir` (bionic มี `forkpty` ตั้งแต่ API 23; libc crate ประกาศไว้โดยไม่ยกเว้น Android); ผู้ใช้ติดตั้ง native binary ใหม่ไม่ได้ |
| **Google Play Device and Network Abuse policy**: ห้ามดาวน์โหลด executable code (dex/JAR/.so) จากนอก Play; ยกเว้นโค้ดที่รันใน VM/interpreter (เช่น JS ใน WebView) — *ถ้อยคำที่แน่นอนยังตรวจจาก primary source ไม่ได้ (§13)* | ไม่มี package manager ใน Play build; proot เฉพาะ sideload/F-Droid build; downloadable JS/WASM ใน WebView ยอมรับได้ |
| **Target API 36** สำหรับแอปใหม่/อัปเดตตั้งแต่ 31 ส.ค. 2026 (ขยายได้ถึง 1 พ.ย. 2026); **16 KB page size** สำหรับ targetSdk ≥ 35 | native libs ทั้งหมด (SSH, PTY, git, zsh) ต้อง build แบบ 16 KB-aligned ใน CI |
| Phantom process killer (Android 12+, จำกัด 32 child process), typed foreground services (14+), dataSync FGS จำกัด 6 ชม./24 ชม. (15+) | ไม่สัญญา persistent local daemon บนโทรศัพท์; build/server ระยะยาวอยู่ที่ somed บนเครื่องผู้ใช้ |
| Scoped storage: SAF ช้ากว่า POSIX 38–78 เท่า; `MANAGE_EXTERNAL_STORAGE` ต้องยื่นแบบฟอร์มและสงวนให้ file-manager | workspace อยู่ใน app-private storage; SAF ใช้เฉพาะ import/export |
| WebView เวอร์ชันต่างกันตามเครื่อง | ตรวจ runtime ว่า Chrome WebView ≥ 120 |

### 3.3 Web / browser

| ข้อจำกัด | ผลต่อการออกแบบ |
| --- | --- |
| **Safari/WebKit ลบ storage** ของไซต์ที่ไม่ได้ใช้ (เดิม 7 วัน; โค้ดปัจจุบันใช้ 7 "operating days" เฉพาะโดเมนที่ถูกจัดเป็น Short และ 30 operating days สำหรับ first-party อื่น); `navigator.storage.persist()` สำเร็จเฉพาะโดเมนที่ได้รับยกเว้นอยู่แล้ว เช่น Home Screen web app — *fact-check รอบ 1 แก้ไขข้ออ้างเดิม* | Web Lite ต้องมี export/sync path และแนะนำติดตั้งเป็น Home Screen app; งานจริงจังให้ใช้ desktop/Full |
| เบราว์เซอร์เปิด raw TCP ไม่ได้ | ไม่มี SSH จาก Web Lite; Web Full ต้องมี somed ทำงานอยู่ |
| File System Access pickers มีเฉพาะ Chromium; OPFS มีใน Chrome/Firefox/Safari 15.2+ | Web Lite ไม่มี local folder บน Firefox/Safari |
| VS Code for the Web ไม่มี terminal/debugger และรันเฉพาะ web extension | tablet "Full workbench" ต้องผ่าน reh-web + somed ไม่ใช่ vscode-web แบบ static |
| TypeScript 7 มีเฉพาะ native binary (ไม่มี wasm) | TS ในเบราว์เซอร์ค้างที่ 6.0; desktop ใช้ TS ที่ VS Code ship มา |

### 3.4 Desktop, terminal และ tooling

| ข้อจำกัด | ผลต่อการออกแบบ |
| --- | --- |
| Windows local PTY ต้องใช้ ConPTY (Windows 10 1809 / build 17763+); node-pty ถอด winpty ออกแล้ว | ขั้นต่ำ Windows 10 1809; cmd.exe ไม่มี shell integration → raw grid |
| macOS App Sandbox ทำให้ spawn shell ของผู้ใช้ไม่ได้ | แจกนอก Mac App Store (Developer ID + notarization) |
| Blocks ต้องการ shell cooperation (OSC 133/633); auto-injection พังใน plain ssh, sub-shell, tmux, nested ssh และ rc แปลก ๆ (p10k, oh-my-zsh, fzf) | ship per-shell init (bash `--rcfile`, zsh `ZDOTDIR`, fish `XDG_DATA_DIRS`, pwsh profile) + SSH bootstrap ของเราเอง + heuristic prompt-based blocks เป็น fallback |
| **xterm.js ไม่มี touch/selection/IME บน mobile** (issue #5377 เปิดอยู่; maintainer: "non-existent", "definitely not a priority"); touch scrolling ถดถอยใน 6.0 | block ที่จบแล้วเป็น DOM; xterm.js เฉพาะ live block/TUI พร้อม touch layer ของเรา |
| **Monaco ไม่รองรับ mobile** (README FAQ: "No.") | editor บนโทรศัพท์ = CodeMirror 6; Monaco เฉพาะ desktop และ tablet ที่มีคีย์บอร์ด |
| Tauri mobile: ตารางใน docs ระบุ `process` = none, `fs`/`shell`/`dialog`/`clipboard-manager`/`deep-link` = partial, `websocket`/`sql`/`store`/`http`/`notification`/`biometric` = full, `updater` = none (fact-check แก้ไขข้ออ้าง "?" ของแผนเดิม); Linux ใช้ WebKitGTK | ทำ fs/PTY/SSH/git ใน Rust core เองไม่พึ่ง plugin; WebSocket ผ่าน browser API; desktop ไม่ใช้ Tauri (ใช้ Electron ของ VS Code) จึงไม่เจอปัญหา WebKitGTK |
| Microsoft VS Code Server / Remote extensions / Marketplace ใช้ได้เฉพาะกับผลิตภัณฑ์ Microsoft; host เป็น service ไม่ได้ | build REH เองจาก fork; ใช้ open-remote-ssh (MIT) + Open VSX |
| Remote resilience (mosh/ET) ต้องการ daemon และ port ฝั่ง server และเป็น GPL (mosh) | ไม่ใช้ mosh; ความทนทานต่อการสลับเครือข่ายมาจาก session ที่อยู่ที่ somed |
| Licensing: Warp client AGPL-3.0, kitty/Ghostty shell scripts GPLv3 (ยืนยัน header แล้ว), Blink/iSH/Termux GPL | ใช้เฉพาะ VS Code shell-integration scripts (MIT) หรือ clean-room จาก OSC 133 spec; cargo-deny + npm license allow-list ใน CI |

---

## 4. ทางเลือกที่พิจารณา

รอบที่ 2 เปรียบเทียบ 4 ทางเลือกสำหรับ "IDE แบบ VS Code + terminal แบบ Warp บนทุกแพลตฟอร์ม" โดยกรรมการ 3 คน (pragmatist, ux-parity, risk) ให้คะแนนเต็ม 10

### 4.1 ตารางคะแนนกรรมการ

| กรรมการ | A — Tauri web UI | B — Flutter + Rust | C — Code-OSS desktop + Tauri mobile + somed | D — Rust/GPUI native | ผู้ชนะ |
| --- | --- | --- | --- | --- | --- |
| pragmatist | 6.80 (mobile 7, feas 8) | 5.05 (mobile 7, feas 4) | **7.00** (mobile 7, feas 7) | 3.25 (mobile 5, feas 1) | C |
| ux-parity | 6.85 (mobile 7.5, feas 7) | 5.15 (mobile 6, feas 4) | **7.35** (mobile 7, feas 6.5) | 3.95 (mobile 4, feas 2) | C |
| risk | 6.55 (mobile 7, feas 7) | 5.20 (mobile 8, feas 4) | **6.75** (mobile 7, feas 6) | 3.55 (mobile 5, feas 2) | C |
| **เฉลี่ย** | **6.7** | **5.1** | **7.0** | **3.6** | **C (3/3)** |

### 4.2 Option C — Branded Code-OSS desktop + Tauri 2 mobile client + daemon `somed` (เลือก; เฉลี่ย 7.0)

- **สรุป**: VS Code fork พร้อม blocks/input-editor contribs และ BYOK AI บน desktop; daemon TypeScript บนเครื่องผู้ใช้ถือ PTY, ไฟล์, git, LSP, DAP และ agents; Tauri 2 + CodeMirror 6 app บนโทรศัพท์/แท็บเล็ตพร้อม Rust SSH/git/PTY; some-ide เดิมเป็น Web Lite
- **ข้อดี**: desktop เป็น VS Code จริง (Open VSX, DAP, tasks, settings, themes, remote dev) ภายใน ~3 เดือน solo; Microsoft ดูแลครึ่ง IDE; blocks สร้างบน command-detection API และ MIT shell-integration scripts ที่ตรวจแล้วว่ามีจริงใน upstream; session ฝั่ง server แก้ปัญหา iOS suspension; tablet Full workbench ผ่าน reh-web; reuse some-ide ~60–70% ของโค้ดที่ไม่ใช่ editor; licensing MIT/Apache สะอาด
- **ข้อเสีย**: 3 deliverables สำหรับคนเดียว; ภาษี upstream-merge 15–20%/เดือนถาวร; blocks contrib อิง terminal internals ที่ไม่ public; Electron 85–150 MB และ xterm WebGL จำกัด rendering ไว้ที่ระดับ VS Code; somed คือ remote code execution โดยธรรมชาติ (ต้องมี Ed25519 pairing + TLS ตั้งแต่ P1); ความเสี่ยง 4.2.7(e) สูงสุดหากฟีเจอร์ offline ไม่จริง
- **เลือกเมื่อ**: ต้องการ VS Code จริงบน desktop ภายในไม่กี่เดือน ยอมรับว่าโทรศัพท์เป็น "จอที่สอง" ของเครื่องตัวเองเป็นหลัก และรักษา cadence การ merge รายเดือนได้ (หรือมีทีม 3–5 คน)

### 4.3 Option A — One TypeScript workbench + Rust core ผ่าน Tauri 2 ทั้ง 6 target (เฉลี่ย 6.7)

- **สรุป**: พัฒนา some-ide เป็น custom workbench แบบ VS Code (Monaco บน desktop, CodeMirror 6 บนโทรศัพท์) พร้อม blocks terminal, LSP broker, DAP client และ extension API ของตัวเอง บน Rust core เดียว
- **ข้อดี**: codebase เดียว; mobile story ดีที่สุด (local Android blocks terminal ใน P1, iOS SSH + sandbox ตรงไปตรงมา); reuse some-ide 70–80%; bundle 2–10 MB; licensing สะอาด
- **ข้อเสีย**: desktop ไม่มีวันเป็น VS Code (extension API ไม่ compatible, LSP broker/DAP/debug UI/settings UI/TextMate ทำเองราวเดือนที่ 7); Linux อยู่บน WebKitGTK (ไม่มี WebGPU, บั๊ก NVIDIA/DMABUF); สอง editor engine ต้องรักษา parity; ไม่มี host daemon จน P4 ทำให้ iOS พึ่ง tmux; ประมาณการ 10–14 เดือน solo มองโลกในแง่ดี (18–24 เดือนสมจริงกว่า)
- **เลือกเมื่อ**: ให้ค่ากับ codebase เดียวมากกว่า VS Code parity และผู้ใช้ต้องการ terminal ที่ดีเยี่ยม + editor ที่ดีพอ

### 4.4 Option B — Flutter 3.47 + Rust core (editor/terminal engine ของตัวเอง) (เฉลี่ย 5.1)

- **สรุป**: Flutter workbench พร้อม custom RenderObject editor และ block-terminal painter บน alacritty_terminal, flutter_rust_bridge ไป Rust core, CPython ฝังบน mobile
- **ข้อดี**: เพดานสูงสุดสำหรับ native phone editor (OS selection handles, IME, 120 Hz, offline Python); UI tree เดียวสำหรับ 6 target; licensing ระวังดี (zsh แทน GPL bash)
- **ข้อเสีย**: reuse some-ide เกือบศูนย์; Dart + Rust สำหรับนักพัฒนา TypeScript; ต้องสร้าง editor engine (re_editor 0.10 ไม่มี multi-cursor/find UI) และ terminal painter (xterm.dart ค้าง ~2 ปี, flutter_pty experimental); ไม่มี VS Code extensions; 13–16 เดือน solo ถึง 1.0; ข้ออ้าง "Ghostty MIT scripts" ผิด (จริง ๆ GPLv3); ข้ออ้าง webview_flutter บน Windows/Linux และ Impeller-default-desktop ไม่ถูกต้อง/ยืนยันไม่ได้
- **เลือกเมื่อ**: มีทีม 3–5 คนที่มีทุนและถนัด Dart + Rust, mobile คือจุดขาย และ VS Code compatibility อยู่นอกขอบเขตโดยชัดแจ้ง

### 4.5 Option D — Rust-native ทุกที่บน GPUI (toolkit ของ Zed) + daemon `kaend` (เฉลี่ย 3.6)

- **สรุป**: Rust workspace เดียว render ด้วย GPUI (Apache-2.0) บน Metal/DirectX/Vulkan, platform layer iOS/Android fork จาก gpui-mobile, alacritty_terminal + OSC 133 blocks, brush-core sandbox shell บน iOS
- **ข้อดี**: แผนเดียวที่มี GPU text pipeline ระดับ Warp/Zed; Host trait และ license discipline เข้มงวด; ซื่อสัตย์เรื่อง iOS; P0 gate เข้มที่สุด
- **ข้อเสีย**: ยอมรับเองว่า solo ส่ง mobile ไม่ได้ (7–9 engineer-years; desktop อย่างเดียว 24–30 เดือน solo); upstream GPUI ไม่มี iOS/Android target; gpui-mobile ไม่มี IME/accessibility; brush-core ไม่มี iOS target และไม่มี hook ดักคำสั่ง; wasmtime บน iOS เป็น Tier 3; editor/terminal crates ของ Zed เป็น GPL ใช้ไม่ได้; ข้อผิดพลาด Ghostty GPLv3 เหมือน B
- **เลือกเมื่อ**: เป็น research spike 3 เดือนของทีม 4–5 คนที่มีวิศวกร Rust/graphics อาวุโส 2 คนและรอ 1.0 ได้ ~2 ปี

### 4.6 สิ่งที่นำมาจากทางเลือกอื่น (grafts) เข้า C

- จาก A: local Android blocks terminal ใน P1 (bionic `forkpty` ของ `/system/bin/sh` + bundled zsh `.so`), labelled "Sandbox" shell (just-bash 3.6, Apache-2.0) บน iOS/web, iOS Files-app visibility ใน P2, `Intl.Segmenter` สำหรับ word navigation ภาษาไทย, freeze block เป็น DOM ผ่าน `@xterm/addon-serialize`, Warp YAML workflow import, withfig/autocomplete spec data
- จาก B: terminal conformance corpus และ Thai/CJK golden tests ตั้งแต่ P0, "host mode" pairing คลิกเดียวจาก desktop, tree-sitter-wasm offline outline บนโทรศัพท์ภายหลัง, bundle zsh แทน GPLv3 bash
- จาก D: `Host` trait (LocalHost/RemoteHost/SandboxHost) เพื่อให้ UI ไม่แตะ process API, auto-upload somed ผ่าน SSH แบบ REH/Zed, versioned protocol + compatibility tests, cargo-deny/npm license allow-list ใน CI, P0 gate ที่มี exit criteria เป็นตัวเลข
- อื่น ๆ: BIS encryption self-classification, PDPA opt-in telemetry, สั่ง Windows OV certificate ใน P1, ส่ง TestFlight เร็วเพื่อเรียนรู้ท่าทีของ Apple
- **ตัดทิ้ง**: Ghostty/kitty scripts (GPLv3); ข้ออ้าง "TypeScript 7 LSP stable" (ไม่เกี่ยวเพราะ desktop ใช้ TS ของ VS Code); ข้ออ้าง webview_flutter/Impeller ของ B; D ทั้งหมดในฐานะ product plan; โค้ด mosh/kitty/Termux/Blink/iSH/Warp client ทุกชิ้น

---

## 5. สถาปัตยกรรมที่เลือก

หลักการ: **โปรโตคอลเดียว สาม deliverables (บวก web edition เดิม)** — desktop fork, daemon `somed`, mobile client — และทุกส่วนใช้ block protocol ชุดเดียวกัน (OSC 633 ของ VS Code)

```
DESKTOP (Win/mac/Linux) "Code-OSS fork"            MOBILE (iOS/Android) "Tauri 2"
┌──────────────────────────────────────┐          ┌──────────────────────────────┐
│ Electron main ── ptyHost (node-pty)  │          │ WebView: CM6 editor, blocks  │
│ renderer: VS Code workbench          │          │  UI, live xterm.js, runners  │
│  + terminalContrib/blocks            │          ├──────────────────────────────┤
│  + terminalContrib/inputEditor       │          │ Rust core: Host trait        │
│ ext host: git, ts, some-ai, runner,  │          │  LocalHost  (Android PTY)    │
│  some-remote (open-remote-ssh fork)  │          │  RemoteHost (somed WSS/SSH)  │
│ [host mode] ── starts & pairs somed  │          │  SandboxHost (just-bash+run) │
└───────────────▲──────────────────────┘          └──────────────▲───────────────┘
                │ WebSocket+TLS, device keys (LAN / Tailscale / later relay)
┌───────────────┴─────────────────────────────────────────────────┴──────────────┐
│ somed (Node 24): PTY+blocks(persisted) · fs/watch · rg · git · LSP/DAP proxy   │
│ ACP agents · workflows · sync · serves vscode-reh-web (tablet Full workbench)   │
│ runs on laptop / VPS / devcontainer; auto-uploaded over SSH when missing        │
└────────────────────────────────────────────────────────────────────────────────┘
WEB: somed-served Full workbench  |  some-ide static "Lite" (no backend)
```

### 5.1 Desktop: branded Code-OSS distribution

- Fork `microsoft/vscode` ที่ stable tag ล่าสุด (1.141.0; Electron 43.7.7, Node 24.18.0; MIT) และคง mergeable ด้วยกติกาจากรอบที่ 1: `product.json` overlay (ชื่อ, ไอคอน, Open VSX `extensionsGallery`, `defaultChatAgent`, API proposals ที่เปิด) → built-in extension → patch เป็นทางเลือกสุดท้าย; patch ไม่เกิน ~15 จุดที่ registration points
- โฟลเดอร์ที่เป็น *additive* เท่านั้น: `src/vs/workbench/contrib/terminalContrib/{blocks,inputEditor}` และ built-in extensions `extensions/{some-ai,some-runner,some-remote}` — ทำให้ merge รายเดือนใช้ 1–3 วัน (VSCodium และ code-server v4.141.0 พิสูจน์รูปแบบนี้)
- **Blocks**: สร้างจาก command detection ของ VS Code เอง (`ICommandDetectionCapability.onCommandFinished`, `ITerminalCommand.getOutput()`) ซึ่งถูกป้อนโดย MIT shell-integration scripts (OSC 633 A/B/C/D/E/P; รับ OSC 133 จาก host ที่ใช้ kitty/Ghostty/WezTerm integration ด้วย) คำสั่งที่จบแล้ว render เป็น virtualised DOM block list เหนือ xterm.js 6 WebGL viewport ที่ย่อลง; เมื่อ alternate screen ทำงาน (vim, htop) raw grid จะเข้ามาแทน
- **Input editor**: Monaco widget ใต้ terminal (shell grammar, Shift+Enter หลายบรรทัด, Terminal Suggest completions ซึ่ง GA ตั้งแต่ 1.107, fuzzy history, NL→command)
- `some-ai`: default chat participant (BYOK providers, tool loop, ACP host สำหรับ CLI agent ภายนอก, MCP); `some-runner`: ห่อ JS/Python/HTML runners ของ some-ide ใน webview panel; `some-remote`: fork ของ open-remote-ssh (MIT) ชี้ไป REH build ของเราเอง
- Upstream tracking (จากรอบที่ 1): nightly CI bump ไป tag ใหม่ → apply patches → compile → smoke tests + Playwright → เปิด PR; ใช้ code-server (ไม่ใช่ VSCodium ที่ค้างที่ 1.135) เป็น early warning ของ conflicting hunks; CI scan ล้ม build หากพบ Marketplace URL, vsda/vsce-sign, Microsoft server binaries, เครื่องหมาย "Visual Studio Code" หรือ vscode-cdn.net

### 5.2 Host daemon `somed`

- TypeScript บน Node 24 runtime ที่ bundle มาแบบ REH (ไม่ใช่ SEA เพื่อให้ node-pty 1.1 และ @vscode/ripgrep prebuilds ใช้ได้)
- หน้าที่: PTY session ที่ inject shell integration แล้วใช้ `@xterm/headless` ตรวจจับคำสั่งและส่ง event `block.start/cmdline/output/end{exit}` ที่ persist ลงดิสก์; fs read/write/watch; ripgrep search; git porcelain; LSP และ DAP proxy; ACP agent host; workflows; settings sync; เสิร์ฟ `vscode-reh-web-*` build ของ fork สำหรับ tablet "Full workbench"
- Session มีอายุยืนกว่า client: โทรศัพท์ที่ถูก iOS suspend แค่ reattach แล้ว replay ด้วย sequence number
- Pairing: QR + Ed25519 device keys + TLS (pinned cert), bind กับ localhost/LAN/Tailscale โดยปริยาย, ไม่มี password auth, revoke รายอุปกรณ์, audit log ของคำสั่ง
- Desktop app เริ่มและ pair somed ด้วยคลิกเดียว ("host mode"); สำหรับ SSH host ที่ไม่มี somed แอป mobile จะอัปโหลด bundle ที่ตรงเวอร์ชันผ่าน SSH channel (รูปแบบ REH/Zed)
- แจกเป็น static tarball (linux x64/arm64, macOS, Windows) และ Docker image สำหรับ server/devcontainer

### 5.3 Mobile: Tauri 2.12 client

- WebView UI เป็น TypeScript ที่พัฒนาต่อจาก some-ide (explorer, search, quick input, problems, phone layout) + Rust core
- Rust core เปิด `Host` trait เดียว มี 3 implementation และ UI ไม่แตะ process API เลย:
  - `LocalHost` (Android): bionic `forkpty` ของ `/system/bin/sh` (mksh) และ `libzsh.so` ที่ bundle แล้ว exec จาก `nativeLibraryDir`; libgit2; workspace ใน app-private storage
  - `RemoteHost` (ทั้งสอง OS): somed ผ่าน WebSocket+TLS หรือ plain SSH ผ่าน russh พร้อม shell-integration bootstrap แบบเดียวกัน (temporary `ZDOTDIR` / `bash --rcfile` / fish `XDG_DATA_DIRS`, implementation ของเราเอง) และ heuristic prompt-based blocks เป็น fallback
  - `SandboxHost` (iOS, web, offline): just-bash บน workspace mirror + runners JS/TS (sucrase), Python (Pyodide ที่ bundle) และ HTML preview ภายใน WebView ติดป้าย "Sandbox" ชัดเจน
- Editor: CodeMirror 6 + vscode-textmate/oniguruma grammars + VS Code theme JSON; `@codemirror/lsp-client` ไป somed; `@codemirror/merge` สำหรับ diff
- Terminal: block ที่จบแล้วเป็น DOM (native selection, copy, share sheet); เฉพาะ live block/TUI เป็น xterm.js พร้อม touch + extra-keys layer
- ข้อมูลถาวรอยู่ฝั่ง Rust (SQLite + ไฟล์) ไม่ใช่ WebView storage; มี `HostBridge` interface เผื่อย้าย UI ไป Capacitor/Expo หาก Tauri mobile สะดุดที่ P0 gate

### 5.4 Web

- (a) **Full**: reh-web ของ fork ที่ somed เสิร์ฟพร้อม device-key auth (รูปแบบ code-server, MIT) — ใช้ได้ดีบน desktop browser และ tablet ที่มีคีย์บอร์ด
- (b) **Lite**: static Vite build ของ some-ide ปัจจุบัน (GitHub Pages/Netlify) ไม่มี backend — sandbox shell + runners เท่านั้น

### 5.5 Shared packages (pnpm monorepo)

`@some/protocol` (JSON-RPC schema, versioned, Rust types mirrored), `@some/blocks-ui`, `@some/input-editor` (Monaco impl / CM6 impl), `@some/ai-core`, `@some/theme`, `@some/workflows`, `@some/commands` บวก `core/` และ `ui/` ของ some-ide

### 5.6 Local vs remote สรุปบรรทัดเดียวต่อแพลตฟอร์ม

| แพลตฟอร์ม | Local | Remote |
| --- | --- | --- |
| Desktop | ทุกอย่าง (shells, toolchains, LSP, DAP, agents) | optional somed / SSH / devcontainers |
| Android | editor, git, search, mksh/zsh blocks terminal, sandbox runners | compilers, LSP, DAP, agents ผ่าน somed/SSH |
| iOS | editor, git (libgit2), search, sandbox shell + runners | shells, toolchains, LSP, DAP, agents **เสมอ** |
| Web Lite | sandbox เท่านั้น | — |
| Web Full | — | ทุกอย่างบน host |

---

## 6. ตารางต่อแพลตฟอร์ม

| แพลตฟอร์ม | Shell (ตัวแอป) | Editor | Terminal | Code execution | ข้อจำกัด |
| --- | --- | --- | --- | --- | --- |
| **Windows 10 1809+ / 11** (x64, arm64) | Branded Code-OSS 1.141 fork (Electron 43.7.7, Node 24.18.0), product.json overlay, Inno/NSIS user+system installers เซ็นด้วย OV certificate; somed sidecar แบบ optional เริ่มจากแอป ("host mode") | Monaco และ VS Code workbench เต็ม: multi-cursor, diff, minimap, splits, TextMate, ฟีเจอร์จาก extension ทั้งหมด | Local PTY ผ่าน ptyHost บน ConPTY (node-pty); blocks เต็มสำหรับ PowerShell 7, Windows PowerShell 5.1, Git Bash และ WSL bash/zsh/fish ด้วย MIT OSC 633 scripts + blocks contrib; cmd.exe เป็น raw grid; live output บน xterm.js WebGL พร้อม DOM fallback | LOCAL: toolchains, WSL, Docker, tasks.json/launch.json, DAP (js-debug, debugpy, CodeLLDB), ACP agents เป็น subprocess, scratch runner webview; REMOTE: optional ผ่าน open-remote-ssh fork / devcontainers กับ REH ของเรา | Azure Trusted Signing ในไทยยืนยันไม่ได้ → งบ OV certificate (~US$250–500/ปี) หรือยอมรับ SmartScreen warning ใน alpha; cmd.exe ไม่มี blocks; GPU rendering เป็น xterm WebGL ไม่ใช่ DirectX/wgpu; bundle ~85–150 MB |
| **macOS 11+** (Apple silicon + Intel) | Code-OSS fork เดียวกัน; .dmg/.zip, Developer ID signed + notarized (Apple Developer Program US$99/ปี); แจกนอก Mac App Store เพราะ App Sandbox จะทำให้ spawn shell ของผู้ใช้ไม่ได้; เป็น "home machine" ตามธรรมชาติของโทรศัพท์ผ่าน somed host mode | Monaco และ VS Code workbench เต็ม | Local PTY (forkpty); blocks เต็มสำหรับ zsh (default), bash (แนะนำ Homebrew bash; /bin/bash 3.2 ใช้กับ script ของ VS Code ได้แต่เก่า), fish, pwsh; contribs เดียวกับ Windows | LOCAL: toolchains, Xcode, Docker, DAP, tasks, agents; somed รันที่นี่เพื่อให้ session ของ iPhone/iPad คงอยู่; REMOTE: optional SSH/devcontainers | Notarization ใน CI ต้องมี Apple account + app-specific password; Gatekeeper ปฏิเสธ build ที่ไม่เซ็น; ไม่มี Metal-level text rendering ใน Electron; macOS จำเป็นสำหรับ build iOS |
| **Linux** (glibc 2.28+, x64/arm64) | Code-OSS fork เดียวกัน; .deb/.rpm/.tar.gz/AppImage และ Flathub; X11 และ Wayland; ไม่ต้อง code signing; somed แจกเป็น headless tarball และ Docker image สำหรับ server/devcontainer (remote host ทั่วไป) | Monaco และ VS Code workbench เต็ม | Local PTY; blocks เต็มสำหรับ bash/zsh/fish/pwsh; rendering เป็น Chromium ของ Electron (xterm WebGL) ไม่ใช่ WebKitGTK จึงไม่เจอปัญหา NVIDIA ของ Tauri/WebKitGTK ใน Option A | LOCAL: toolchains, Docker/podman, devcontainers ผ่าน devcontainer CLI + REH ของเรา, DAP, agents; REMOTE: optional | Snap/Flatpak sandbox ทำให้ local PTY และ somed pairing ยุ่งยาก (ship .deb/.rpm/AppImage ก่อน; Flatpak ผ่าน `flatpak-spawn --host` ภายหลัง); ปัญหา GPU เป็นของ Electron/driver |
| **iOS / iPadOS 16+** (iPhone, iPad; ยก Tauri default 15 → 16) | Tauri 2.12: WKWebView UI + Rust core (russh 0.64, git2 0.21 + libssh2, tokio-tungstenite, Keychain ผ่าน security-framework); ใช้เฉพาะ Tauri plugins ที่รองรับ mobile (sql, store, dialog, clipboard-manager, http, notification, deep-link, biometric, log); build ด้วย Xcode 26 บน Mac; TestFlight → App Store | CodeMirror 6 (contenteditable: OS selection handles, IME, Thai composition) + vscode-textmate/oniguruma grammars + VS Code theme JSON, extra-keys row, @codemirror/merge diffs, @codemirror/lsp-client ไป somed; offline edit ใน Rust-backed workspace mirror + diff3 merge เมื่อเชื่อมต่อใหม่; iPad + คีย์บอร์ด: "Full workbench" mode โหลด reh-web จาก somed ใน WKWebView เดียวกัน (P3) | **REMOTE เท่านั้น** — ไม่มี local shell: (1) somed session บน Mac/PC/Linux/container ของผู้ใช้ผ่าน WebSocket+TLS พร้อม block UX เต็มและ persistence ฝั่ง server (reattach หลัง suspend ~20–30 วิ), (2) plain SSH ผ่าน russh พร้อม bootstrap shell integration (bash/zsh/fish) และ heuristic fallback, (3) "Sandbox" shell ที่ติดป้ายชัด (just-bash บน workspace mirror) ซึ่ง spawn process/เปิด socket/ติดตั้ง package ไม่ได้; block ที่จบแล้วเป็น DOM, live block/TUI เป็น xterm.js + touch layer | LOCAL เฉพาะใน WKWebView และเฉพาะโค้ดที่ผู้ใช้เขียนและมองเห็นได้: JS/TS (sucrase + module worker จาก some-ide), Python (Pyodide bundle ในแอป ไม่มี network package install ใน store build), HTML preview เปิดใน SFSafariViewController; git ผ่าน libgit2 ใน Rust; REMOTE สำหรับของจริงทั้งหมด: compilers, Node, Docker, LSP servers, debuggers, agents | ไม่มี child process, extension host, package manager; App Store 2.5.2 และ 4.2.7(e) (offline editor + git + sandbox + SSH ทำให้เป็นแอปจริงตามรูปแบบ Blink/Termius/Code App); Xcode 26 SDK บังคับตั้งแต่ 28 เม.ย. 2026; เข้าถึง Files เฉพาะ app container (UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace ใน P2) และ document-picker bookmarks (P4), File Provider P5; ข้อมูลถาวรต้องอยู่ใน Rust-side SQLite/ไฟล์; VPN ได้ทีละตัว (Tailscale vs corporate VPN); ต้องมี Mac |
| **Android 8+** (minSdk 26, targetSdk 36, 16 KB-aligned .so; phone, tablet, DeX/ChromeOS) | Tauri 2.12: Android System WebView + Rust core เดียวกัน (+ Kotlin plugin ~100 บรรทัดสำหรับ Keystore, SAF import/export, keyboard insets); AAB บน Play (internal testing ตั้งแต่ P1) และ APK sideload/F-Droid build | CodeMirror 6 stack เดียวกับ iOS; ตรวจ Gboard/Thai composition บนเครื่องจริงใน P0 | **LOCAL blocks terminal ตั้งแต่ P1**: Rust forkpty (bionic export ตั้งแต่ API 23; libc crate ประกาศสำหรับ Android) รัน /system/bin/sh (mksh, PS1-only integration + command-start markers จาก input editor ของเรา) และ zsh ที่ bundle เป็น lib/arm64-v8a/libzsh.so exec จาก nativeLibraryDir พร้อม MIT zsh script ของ VS Code (Android 10 W^X อนุญาต "load only binary code embedded within the APK"); ไม่มี package manager ใน Play build (proot optional เฉพาะ sideload); บวก REMOTE session ผ่าน somed/SSH เหมือน iOS | LOCAL: shell scripting ใน mksh/zsh, bundled toybox commands, git ผ่าน libgit2, sandbox runners ใน WebView (JS/TS, Pyodide ที่ bundle); REMOTE: compilers, Node-based LSP servers, debuggers, agents ผ่าน somed/SSH | Play ห้ามดาวน์โหลด native code (.so/dex) และบังคับ target API 36 + 16 KB pages; W^X บล็อก exec จาก app data; phantom-process killer (32 children) และ foreground-service caps → ไม่มี persistent local daemon; SAF ช้ากว่า POSIX 38–78 เท่า → workspace ใน app-private storage + SAF import/export; WebView version variance (ตรวจ Chrome WebView ≥ 120 ตอน runtime); bundle GPLv3 bash ต้องมี source offer จึงใช้ zsh |
| **Web** (desktop browsers; tablet + คีย์บอร์ด) | (a) "Full": `vscode-reh-web-<target>` build ของ fork ที่ somed เสิร์ฟพร้อม device-key auth (รูปแบบ code-server, MIT); (b) "Lite": static Vite build ของ some-ide ปัจจุบัน (GitHub Pages/Netlify) ไม่มี backend | (a) VS Code web workbench เต็ม extensions รันบน extension host ของ somed; (b) Monaco เหมือนปัจจุบัน (โหมด CodeMirror 6 สำหรับ phone browser ภายหลัง) | (a) VS Code terminal ผ่าน REH พร้อม blocks contrib เดียวกัน (PTY บน host); (b) Sandbox shell เท่านั้น (just-bash + runners) | (a) REMOTE บน host (toolchains, DAP, agents); (b) LOCAL ใน browser workers เท่านั้น (sucrase, Pyodide, sandboxed iframe) | (a) ต้องมี somed รันอยู่และใช้บน phone Safari ได้ไม่ดี (tablet ใช้ได้); (b) Safari ลบ storage หลัง ~7–30 วันที่ไม่ได้ใช้เว้นแต่ติดตั้งเป็น Home Screen app; ไม่มี filesystem จริง; ไม่มี SSH (browser เปิด raw TCP ไม่ได้) |

---
