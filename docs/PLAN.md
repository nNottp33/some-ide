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

## 7. Technology stack

| ด้าน | ทางเลือก | เหตุผล |
| --- | --- | --- |
| Desktop shell | Code-OSS fork pin กับ upstream stable (1.141.0; Electron 43.7.7 / Node 24.18.0 ตาม `.npmrc`/`.nvmrc`), product.json overlay (ชื่อ, ไอคอน, Open VSX extensionsGallery, defaultChatAgent, API proposals), patch ≤15 + additive folders `terminalContrib/{blocks,inputEditor}` และ `extensions/{some-ai,some-runner,some-remote}`; ใช้ build scripts ของ VSCodium (MIT) เป็นแบบอ้างอิง | MIT, stable tag รายสัปดาห์, extension host เต็ม, PTY/DAP จริง; additive folders ทำให้ merge รายเดือนใช้ 1–3 วัน (VSCodium และ code-server v4.141.0 พิสูจน์แล้ว) |
| Block protocol | OSC 633 A/B/C/D/E(cmdline+nonce)/P(Cwd, HasRichCommandDetection) ตามที่ MIT scripts ของ VS Code ปล่อย (shellIntegration-bash.sh, -zsh, .fish, .ps1); รับ OSC 133 A–D จาก host ที่ใช้ kitty/Ghostty/WezTerm integration; OSC 1337 CurrentDir | โปรโตคอลที่มีเอกสารครบที่สุดและมี nonce ยืนยัน command line; script ชุดเดียวใช้ได้ทั้ง desktop, somed และ SSH bootstrap; **ไม่ใช้** scripts ของ Ghostty (GPLv3) |
| Desktop block UX | in-tree `terminalContrib/blocks` ใช้ `ICommandDetectionCapability` / `ITerminalCommand.getOutput()` (capability เดียวกับ stickyScroll, commandGuide และ chat) render `@some/blocks-ui` DOM เหนือ xterm.js 6 WebGL viewport ที่ย่อลง; auto raw-grid เมื่ออยู่ alternate buffer; ปิด blocks ได้ด้วย flag หาก upstream release ทำพัง | ใช้ command detection, decorations, Run Recent Command history และ terminal chat ของ VS Code ซ้ำ; ไม่มี terminal engine ตัวที่สอง |
| Terminal input editor | interface `@some/input-editor`; desktop impl = Monaco widget ใต้ terminal (shellscript grammar, Shift+Enter, completions จาก `ITerminalCompletionService` + in-tree terminal-suggest spec data (GA ตั้งแต่ 1.107), fuzzy history); mobile impl = CodeMirror 6 ใช้ provider เดียวกันผ่าน somed RPC; withfig/autocomplete (MIT) spec JSON เป็นข้อมูล completion เพิ่ม | Terminal Suggest เป็น GA และ MIT; Monaco บน desktop ไม่มีต้นทุนเพิ่ม; provider เดียวกันใช้บนโทรศัพท์ได้ |
| Host daemon (somed) | TypeScript บน bundled Node 24 (แบบ REH ไม่ใช่ SEA เพื่อ node-pty 1.1 และ @vscode/ripgrep prebuilds), `@xterm/headless` 6.0.0 + `@xterm/addon-serialize` สำหรับ command detection และ replay ฝั่ง server, JSON-RPC 2.0 บน WebSocket (binary frames), Ed25519 device pairing (QR) + TLS, เสิร์ฟ `vscode-reh-web-*`; static tarballs linux x64/arm64, macOS, Windows; auto-upload ผ่าน SSH เมื่อไม่มี/เวอร์ชันไม่ตรง | ผู้สร้างยังอยู่ใน TypeScript; รูปแบบเดียวกับ code-server; session คงอยู่โดยไม่ขึ้นกับ client (iOS suspension); remote แบบ zero-install |
| Mobile shell | Tauri 2.12 (CLI 2.12.1, Apache-2.0 OR MIT): WKWebView / Android System WebView + Rust core; ใช้เฉพาะ plugins ที่รองรับ mobile (sql, store, dialog, clipboard-manager, http, notification, deep-link, biometric, log); fs/PTY/SSH/git ทำใน Rust ไม่ผ่าน fs/shell/process/websocket plugins; `HostBridge` interface เผื่อ rehost UI ใน Capacitor/Expo | TypeScript UI เดียวกับ some-ide และ desktop packages; Rust ให้ SSH/git/PTY โดยไม่มี subprocess; แอป 5–10 MB; Capacitor ไม่มี desktop story และต้อง native SSH plugin; Flutter/RN ก็ต้องห่อ WebView editor เดียวกันอยู่ดี |
| Mobile Rust core | `Host` trait: LocalHost (Android: libc forkpty ของ /system/bin/sh + bundled libzsh.so; git2 0.21 + libssh2), RemoteHost (russh 0.64.1 Apache-2.0, tokio-tungstenite ไป somed), SandboxHost (just-bash 3.6 Apache-2.0 บน workspace mirror + runners); SQLite + ไฟล์สำหรับ durable state; diff3 merge ผ่าน crate `similar`; keyring/Keystore สำหรับ secrets | UI ไม่แตะ process API → build iOS ซื่อสัตย์โดยโครงสร้าง; libc ประกาศ forkpty/openpty สำหรับ Android; russh build ได้สำหรับ aarch64-apple-ios |
| Mobile editor | CodeMirror 6 (@codemirror/view 6.43.14, @codemirror/language, @codemirror/merge, @codemirror/lsp-client 6.3.0, MIT ทั้งหมด) + vscode-textmate 9.3.2 / vscode-oniguruma 2.0.1 bridge สำหรับ VS Code grammars และ theme JSON; extra-keys row; `Intl.Segmenter` สำหรับ word navigation ภาษาไทย; web-tree-sitter wasm ภายหลังสำหรับ offline outline | Monaco FAQ ระบุไม่รองรับ mobile; CM6 เป็น contenteditable (OS handles, IME, ไทย, accessibility) และ render เฉพาะ viewport |
| Mobile terminal rendering | `@some/blocks-ui` DOM blocks (virtualised, ANSI→spans จาก addon-serialize output) สำหรับคำสั่งที่จบแล้ว; xterm.js 6.0 + addon-webgl เฉพาะ live block และ TUI ห่อด้วย touch layer (tap-focus, long-press select, pinch zoom, แถบ Esc/Tab/Ctrl/arrows) | xterm.js issue #5377 (mobile touch/IME) ยังเปิดและ maintainer บอกว่า mobile support "non-existent"; จำกัดไว้ที่ live surface ทำให้ output ที่จบแล้วได้ native copy/share |
| Language intelligence | Desktop: VS Code built-ins (TypeScript, JSON/CSS/HTML, Markdown) + servers จาก Open VSX (basedpyright, clangd, rust-analyzer, gopls); Mobile: somed LSP proxy spawn typescript-language-server, basedpyright, clangd แล้ว multiplex เข้า @codemirror/lsp-client; offline = syntax เท่านั้น (tree-sitter outline ภายหลัง) | diagnostics เหมือนกันทั้งสองอุปกรณ์เพราะ server ตัวเดียวกันรันบน host; ไม่ต้อง port อะไรไปโทรศัพท์; Microsoft-only servers (Pylance ฯลฯ) แทนด้วยของเปิด |
| Debugging | Desktop: VS Code DAP (js-debug built-in, debugpy, CodeLLDB); Mobile: somed DAP proxy + mobile debug UI ขนาดเล็ก (breakpoints, step, call stack, variables, console) | DAP เป็น JSON ที่ไม่ผูกกับ client; งานใหม่มีแค่ mobile UI |
| Git | Desktop: in-tree git extension; Mobile online: somed git RPC บน git CLI porcelain v2; offline: git2 0.21 (libgit2 + libssh2) commit ไว้ก่อนแล้ว push ทีหลัง | พฤติกรรมฝั่ง server เหมือน desktop; libgit2 เป็น native git ที่พิสูจน์แล้วบน iOS/Android (แอประดับ Working Copy) |
| Search | Desktop: @vscode/ripgrep; Mobile: somed search RPC stream ผล ripgrep; offline: `src/core/search.ts` ของ some-ide บน mirror | engine และผลลัพธ์เดียวกัน; offline path มี test อยู่แล้ว |
| AI | `@some/ai-core` (BYOK: Anthropic, OpenAI, Google, OpenRouter, Ollama; key ใน SecretStorage/Keychain/Keystore); Desktop: some-ai เป็น defaultChatAgent ผ่าน vscode.chat/vscode.lm, tools ผ่าน vscode.lm.registerTool + core MCP; agent ภายนอกผ่าน ACP (@agentclientprotocol/sdk 1.8.0 Apache-2.0; `terminal/create \| output \| wait_for_exit \| kill \| release` implement บน blocks); Mobile: loop เดียวกันและ ACP agents รันใน somed, แอป render session และ permission prompts | ไม่พึ่ง GitHub Copilot services (ความเสี่ยง ToS ใน fork; โค้ด in-tree MIT `extensions/copilot` ใช้เป็นแบบอ้างอิงเท่านั้น); ACP ให้ agent mode กับ CLI agent ใดก็ได้ |
| Extensions | Open VSX ผ่าน product.json (URL ตั้งค่าได้ + caching mirror สำหรับ extension ของเราเอง); publish ด้วย @vscode/vsce; mobile โหลดเฉพาะ data packs (themes, grammars, snippets, icon themes) ที่ somed unpack; executable extensions บน tablet เฉพาะผ่าน Full-workbench mode บน host ของ somed | เงื่อนไข Microsoft Marketplace จำกัดเฉพาะผลิตภัณฑ์ Visual Studio; App Store 2.5.2 และ Play policy ห้าม executable code ที่ดาวน์โหลดบนโทรศัพท์; **หมายเหตุ**: free tier ของ Open VSX "ไม่ได้ตั้งใจสำหรับ commercial offerings" (fact-check รอบ 1) → ดู §12 |
| Offline mode & sync | Rust workspace mirror (SQLite index + ไฟล์, base revision ต่อไฟล์), change journal, diff3 merge เมื่อเชื่อมต่อใหม่พร้อม conflict UI; settings/keybindings/workflows sync เป็นไฟล์ผ่าน somed; Yjs live co-editing เป็นทางเลือกภายหลัง | durable storage ห้ามพึ่ง WebView IndexedDB บน iOS; 3-way merge ระดับไฟล์ครอบคลุมการใช้งานหลายอุปกรณ์ของนักพัฒนาคนเดียวโดยไม่ต้องใช้ CRDT |
| Connectivity | mDNS/QR pairing บน LAN; แนะนำ Tailscale สำหรับ roaming (VPN ได้ทีละตัวบน mobile); plain SSH ผ่าน russh เป็น fallback สากล; optional first-party end-to-end-encrypted relay ใน P5; ไม่ต้องใช้ mosh/Eternal Terminal เพราะ somed ถือ session (ET, Apache-2.0, optional ภายหลัง) | ความทนทานต่อการ roam มาจาก persistence ฝั่ง server แทน transport ที่เป็น GPL |
| Data-format compatibility | import Warp workflow YAML (warpdotdev/workflows, Apache-2.0); VS Code snippet JSON; VS Code settings/keybinding keys บน mobile; importer สี iTerm2/Ghostty/Windows Terminal; codicons (CC-BY-4.0 สำหรับไอคอน + MIT สำหรับโค้ด; ต้องมี attribution) | ผู้ใช้ Warp และ VS Code ย้ายมาได้ฟรีโดยไม่มีโค้ด copyleft |
| i18n | Mobile: string ไทย + อังกฤษของเราเองตั้งแต่วันแรก; Desktop: Thai language-pack extension ของเราเอง (localizations contribution; export string จาก NLS metadata ของ fork, machine-translate แล้ว review, ~3k string ที่เห็นบ่อยที่สุดก่อน) | vscode-loc มี 14 language packs (13 ภาษาจริง + qps-ploc) และไม่มีภาษาไทย (ยืนยันแล้ว) → UI ไทยต้องเป็นของเรา |
| Build, signing, QA, compliance | GitHub Actions matrix (Windows OV signtool; macOS notarytool; Linux deb/rpm/AppImage/Flathub; iOS ผ่าน macOS runner + Fastlane/TestFlight; Android AAB 16 KB-aligned .so); Vitest 5 + Playwright 1.64 (desktop + phone viewports) จาก some-ide; VS Code test runner สำหรับ contribs; Rust tests; terminal conformance corpus (vttest/esctest-style recorded sessions) + Thai/CJK golden tests; cargo-deny + npm license allow-list (MIT/Apache/BSD/MPL-2.0/libgit2 exception); versioned protocol compatibility tests; BIS encryption self-classification; PDPA opt-in telemetry | release engineering คือครึ่งที่ซ่อนอยู่ของ fork; allow-list คือสิ่งที่จะจับข้อผิดพลาด Ghostty GPLv3 ได้ |

---

## 8. Feature matrix

ระดับ: **full** = เทียบเท่า VS Code/Warp, **partial** = มีแต่จำกัด (ตามข้อจำกัดใน §3)

| ฟีเจอร์ | วิธีทำ | Desktop | Mobile | Phase |
| --- | --- | --- | --- | --- |
| Workbench layout (activity bar, side bar, panel, status bar, editor groups/splits) | Desktop: VS Code ไม่แก้; Phone: คอลัมน์เดียว, bottom tab bar (Files/Search/Git/Terminal/AI), editor group เดียว, panel เป็น bottom sheet (ต่อยอดจาก layout ที่ทดสอบบน Pixel 7 ของ some-ide, NARROW=720); Tablet: sidebar + editor + terminal, 2 editor groups; ผู้ใช้คีย์บอร์ดได้ Full-workbench mode (reh-web จาก somed) | full | partial | P1 phone, P3 tablet |
| Editor core (multi-cursor, diff, minimap, touch selection handles, extra-keys row, Thai/IME) | Desktop: Monaco ใน VS Code; Mobile: CM6 multiple selections, @codemirror/merge diffs, ไม่มี minimap โดยตั้งใจ, OS selection handles ผ่าน contenteditable, extra-keys row, Intl.Segmenter สำหรับคำไทย; P0 device matrix เป็น gate ของ Thai composition | full | partial | P0 test, P1 |
| File explorer (real FS; iOS Files integration) | Desktop: VS Code explorer; Mobile: remote tree จาก somed พร้อม watch events (P1); Android app-private workspace + SAF import/export และ iOS app container ใน Files (P2); iOS document-picker folders (P4); File Provider (P5); `explorer.ts` ของ some-ide (drag-drop, inline rename) เป็นฐาน | full | partial | P1 remote, P2 local, P4/P5 pickers |
| Search & replace ข้ามไฟล์ | Desktop: VS Code search (ripgrep); Mobile: somed search/replace RPC stream ripgrep matches เข้า search-view ของ some-ide; offline ผ่าน `src/core/search.ts` บน mirror | full | full | P1 |
| Source control (status/diff/stage/commit/branches/push/pull) | Desktop: built-in git extension (+ GitLens-alternatives จาก Open VSX); Mobile: somed git RPC (status, diff viewer, hunk staging, commit, branches, pull/push, log) และ git2 offline commits sync ภายหลัง | full | full | P1 status/commit, P2 branches/push/pull |
| Language intelligence (LSP สำหรับ TS/JS, Python, compiled language หนึ่งภาษา) | Desktop: built-in TypeScript, basedpyright และ clangd/rust-analyzer จาก Open VSX; Mobile: somed spawn typescript-language-server, basedpyright, clangd แล้ว proxy ไป @codemirror/lsp-client (completion, hover, diagnostics, go-to, rename); offline: syntax เท่านั้น; iOS รัน server ใด ๆ ในเครื่องไม่ได้ | full | partial | P2 |
| Debugger (DAP) | Desktop: VS Code debugging (js-debug, debugpy, CodeLLDB); Mobile: somed DAP proxy + mobile UI (gutter breakpoints, continue/step, call stack, variables, console); ไม่มี local debugging บนโทรศัพท์ | full | partial | P4 |
| Tasks / run | Desktop: tasks.json/launch.json เหมือน VS Code; "Run file" ผ่าน Scratch Runner extension; Mobile: tasks รันโดย somed เป็น blocks; "Run file" ผ่าน somed หรือ offline sandbox runners (JS/TS, Python, HTML) | full | partial | P1 runners, P2 tasks |
| Extensions (API, marketplace, mobile) | Desktop: VS Code extension API เต็ม + Open VSX; Phone: ไม่มี extension host (App Store 2.5.2 / Play policy); data packs (themes, grammars, snippets, icon themes) ติดตั้งจาก Open VSX ผ่าน somed; Tablet ใน Full-workbench mode รัน extension ใดก็ได้บน extension host ของ somed | full | partial | P1 desktop, P3 tablet, P4 data packs |
| Command palette & quick open | Desktop: VS Code; Mobile: quick-input ของ some-ide (Ctrl+P ไฟล์, `>` คำสั่ง, `:` บรรทัด) + `@` symbols จาก LSP เป็น touch sheet ด้วย command id เดียวกัน | full | full | P1 |
| Settings & keybindings | Desktop: VS Code settings UI/JSON; Mobile: settings sheet สำหรับ subset ที่คัดไว้ด้วย key เดียวกัน (editor.fontSize/tabSize/wordWrap, workbench.colorTheme, terminal.integrated.*, AI provider), shortcut คีย์บอร์ดภายนอกจาก keybindings.json subset; sync เป็นไฟล์ผ่าน somed | full | partial | P2 |
| Themes / TextMate grammars | theme JSON และ TextMate grammars ของ VS Code ชุดเดียวกัน: desktop ใช้ตรง; mobile ผ่าน vscode-textmate 9.3.2 + oniguruma 2.0.1 wasm เข้า CM6 decorations และ CSS variables ของ @some/theme | full | full | P1 |
| Problems / outline / breadcrumbs | Desktop: VS Code; Mobile: Problems จาก LSP diagnostics ผ่าน somed (problems-view ของ some-ide), outline จาก documentSymbol หรือ tree-sitter-wasm offline, breadcrumbs = path + enclosing symbol | full | partial | P2 problems, P3/P4 outline |
| Multi-root workspaces | Desktop: .code-workspace; Mobile: somed เปิด workspace folders เป็น roots ใน tree เดียว; ไม่มี per-root settings UI | full | partial | P4 |
| Remote development (SSH/containers) และ multi-device sync | Desktop: open-remote-ssh fork ชี้ serverDownloadUrlTemplate ไป REH ของเรา; devcontainers ผ่าน devcontainer CLI + REH ของเรา; somed ใน container สำหรับโทรศัพท์; Multi-device: workspace บน somed + file-based settings sync; Yjs ภายหลัง | full | partial | P2 SSH, P4 containers, P5 Yjs |
| AI assistant / agents | Desktop: some-ai default chat participant (BYOK), tool loop ด้วย vscode.lm tools + MCP, ACP host สำหรับ CLI agents พร้อม approvals; Mobile: loop เดียวกันและ ACP agents รันใน somed บน host; แอปแสดง streaming sessions, diffs, permission prompts, push notification (optional) | full | full | P1 terminal AI, P3 chat/agent |
| i18n รวม UI ไทย | Mobile: ไทย + อังกฤษตั้งแต่วันแรก; Desktop: Thai language pack ของเรา (vscode-loc ไม่มี), string ที่เห็นบ่อยก่อน; fallback อังกฤษ | partial | full | P2 mobile, P3 desktop |
| Blocks UX (หน่วย command+output: navigate, copy, share) | ทั้งสองฝั่ง render @some/blocks-ui: header (cmdline, cwd, exit code, duration), collapse, select/copy output, rerun, bookmark, filter, prev/next, share เป็น Markdown/JSON; Desktop สร้าง blocks จาก command detection บน xterm buffer + raw-grid toggle สำหรับ TUI; Mobile รับ block events จาก somed หรือ parse OSC 633/133 เอง (Android PTY, SSH) | full | full | P1 |
| Command input editor สมัยใหม่ (หลายบรรทัด, completions, history search) | Desktop: Monaco widget ใต้ terminal (shell grammar, Shift+Enter, Terminal Suggest + withfig spec data, fuzzy history, submit ผ่าน shell-integration executeCommand); ซ่อนเมื่อ TUI ถือ PTY; Mobile: CM6 input + history chips + extra keys, completions จาก somed หรือ local specs | full | full | P1 desktop, P2 mobile |
| AI: natural language → command, อธิบาย error, agent mode | NL→command (Ctrl+I / prefix `#`; preview เสมอ ไม่ auto-run), Explain เมื่อ exit ≠ 0 โดยใช้ท้าย output ของ block, Fix suggestions; agent mode = @some/ai-core loop หรือ ACP agent ที่ map `terminal/*` ไป blocks; เหมือนกันบน mobile ผ่าน somed | full | full | P1 NL/explain, P3 agent |
| Workflows / snippets / runbooks | Warp-compatible YAML workflows (name, command template, arguments, tags) ใน `~/.some/workflows` และ `.some/workflows` ต่อ repo; snippets ใช้ VS Code snippet JSON; runbooks = Markdown ที่มี fenced block รันได้เป็น terminal blocks | full | full | P2 workflows/snippets, P4 runbooks |
| Split panes / tabs | Desktop: terminal tabs, splits และ editor-area terminals ของ VS Code ตามเดิม; Mobile: session tabs บนโทรศัพท์; split 2 pane เฉพาะ tablet | full | partial | P2 |
| Shell integration สำหรับ bash/zsh/fish/PowerShell | MIT scripts ของ VS Code auto-inject บน desktop (bash, zsh, fish, pwsh 7, Windows PowerShell 5.1, Git Bash) และโดย somed บน host; Android mksh ได้ PS1-only markers, zsh ที่ bundle ได้ script เต็ม; nushell และ cmd.exe เป็น raw grid | full | full | P1 |
| SSH sessions ด้วย block UX เดียวกัน | Desktop: `ssh` ใน block terminal trigger remote bootstrap ของ scripts (implementation ของเราเองตามแนวคิด Warpify/kitten-ssh; bash/zsh/fish; pwsh ผ่าน profile snippet) + open-remote-ssh สำหรับ remote workbench เต็ม; Mobile: russh client + bootstrap เดียวกัน; heuristic prompt-based blocks เมื่อ bootstrap ไม่ได้ (restricted shells, nested ssh, tmux); somed auto-upload สำหรับ persistence | full | full | P2 |
| GPU-fast rendering / large output | live output อยู่บน xterm.js WebGL (DOM fallback); block ที่จบแล้วเป็น virtualised DOM + lazy ANSI conversion, collapse เกิน N บรรทัดพร้อม in-block search; somed coalesce PTY reads, journal scrollback ลงดิสก์, cap live buffer; เป้า: 60 fps เลื่อน block 50k บรรทัด, `cat` 200 MB ไม่ค้าง; **ไม่อ้าง** parity ระดับ Metal/wgpu กับ Warp/Ghostty | partial | partial | P1 baseline, P4 budgets |
| Terminal themes | VS Code terminal colour keys และ theme extensions บน desktop; mobile ใช้ JSON เดียวกัน; importer scheme iTerm2/Ghostty/Windows Terminal เข้า workbench.colorCustomizations | full | full | P1, P4 import |
| Terminal บน iOS / Android โดยเฉพาะ | iOS: **ไม่มี local shell** (Apple ห้าม child process); terminal = somed session บนเครื่องผู้ใช้ หรือ SSH ผ่าน russh พร้อม blocks และ persistence ฝั่ง server + Sandbox shell ที่ติดป้าย (just-bash + runners); Android: **LOCAL blocks terminal ตั้งแต่ P1** (forkpty ของ /system/bin/sh + bundled libzsh.so จาก nativeLibraryDir, ไม่มี package manager บน Play) + remote เหมือนกัน; proot เฉพาะ sideload build; ทั้งคู่: extra-keys bar, hardware keyboard, Ctrl/Esc modifiers, reconnect หลัง suspension | full | partial | P1 Android, P2 iOS |

---

## 9. การนำโค้ดเดิมมาใช้

สถานะ repo (ตรวจในเครื่องเมื่อ 2026-10-09): `/home/user/some-ide`, TypeScript 5,374 บรรทัดใน `src/**/*.ts` (5,898 บรรทัดเมื่อรวม tests/, e2e/ และ config), monaco-editor ^0.57, typescript ^7.0.2, vite ^8.3.4, vitest ^5, @playwright/test ^1.64; breakpoint โทรศัพท์ `NARROW = 720` ใน `src/workbench.ts`; `e2e/mobile.spec.ts` ขับ viewport Pixel 7; `src/runner/py-worker.ts` โหลด Pyodide 314.0.7 จาก cdn.jsdelivr.net

หลักการ: some-ide **ยังอยู่** ในฐานะ Web "Lite" edition ฟรี และถูก "ขุด" ไปใช้ในแอป mobile และ desktop runner extension; ประมาณ **60–70% ของโค้ดที่ไม่ใช่ editor** ถูกใช้ซ้ำ (รอบที่ 1 ซึ่งเป็น desktop-only ประเมินไว้แค่ 35–45% เพราะไม่มี mobile client ที่จะรับ UI ไป)

### 9.1 ใช้ซ้ำตรง ๆ หรือ refactor เล็กน้อยในแอป mobile

| ไฟล์ | บทบาทใหม่ |
| --- | --- |
| `src/core/vfs.ts` (201 บรรทัด) | `VirtualFS` + `FsEvent` model เป็น in-memory layer ของ workspace mirror บน mobile; persistence ย้ายจาก IndexedDB ไป Rust SQLite/file store |
| `src/core/storage.ts` | fallback chain และวินัย try/catch ไปต่อใน storage layer ใหม่ |
| `src/core/path.ts`, `src/core/emitter.ts`, `src/core/settings.ts` | ใช้ตามเดิม |
| `src/core/fuzzy.ts` | quick open + history search ใน input editor |
| `src/core/search.ts` | offline search/replace บน mirror |
| `src/core/zip.ts`, `src/ui/transfer.ts` | project import/export (SAF/Files) |
| `src/commands.ts` | `CommandRegistry` + `keybindingOf`; เปลี่ยน command id ให้ตรงกับของ VS Code |
| `src/ui/quick-input.ts` | flow Ctrl+P / `>` / `:` เป็น touch sheet |
| `src/ui/explorer.ts` (564 บรรทัด) | tree, drag-drop, inline create/rename, context menus |
| `src/ui/search-view.ts`, `src/ui/problems-view.ts`, `src/ui/console-view.ts`, `src/ui/dialogs.ts`, `src/ui/dom.ts` (`h()`), `src/ui/file-icon.ts` | view ของ mobile workbench-lite |
| กฎ responsive ใน `src/styles.css` + `NARROW = 720` ใน `src/workbench.ts` | phone layout |
| `tests/core.test.ts`, `tests/runner.test.ts`, `e2e/ide.spec.ts`, `e2e/mobile.spec.ts` | test setup และ phone-viewport e2e ไปต่อใน monorepo |

### 9.2 ใช้ซ้ำในที่ใหม่

- `src/runner/*` (~1,100 บรรทัด: `js-worker.ts` ที่ใช้ sucrase + es-module-lexer blob linking และ esm.sh, `modules.ts`, `py-worker.ts` กับ Pyodide, `html.ts` preview builder, `inspect.ts` Node-style console formatter, `protocol.ts`, `runner.ts`) กลายเป็น (a) desktop built-in "Scratch Runner" extension (webview panel) และ (b) offline sandbox runner บน mobile
- `py-worker.ts` ปัจจุบันโหลด Pyodide จาก CDN (`PYODIDE_VERSION`, override ด้วย `VITE_PYODIDE_URL`) → store builds ต้อง **bundle Pyodide** และปิดการโหลด package ผ่าน esm.sh/micropip บน iOS

### 9.3 ใช้ซ้ำเฉพาะแนวคิด / ไม่ใช้ซ้ำ

- `src/workbench.ts` (~1,000 บรรทัด) ถูกแยก: logic layout/panel/tab ไปเลี้ยง mobile workbench-lite ส่วนที่ผูกกับ Monaco ตัดทิ้ง
- `src/editor/*` (`monaco.ts`, `documents.ts`, `editor-area.ts`) ไม่ใช้บน desktop เพราะ desktop คือ workbench ของ VS Code เอง; บน mobile แนวคิด `DocumentManager` ถูก re-target ไป CodeMirror 6 `EditorState` และ custom Monaco themes แทนด้วย VS Code theme JSON

### 9.4 Bug จาก review ที่เปิดอยู่ 9 รายการ — กำลังแก้ใน P0

โค้ดชุดนี้จะกลายเป็นฐานของแอป mobile จึงต้องแก้ก่อนเริ่ม refactor:

| # | ปัญหา | ประเภท |
| --- | --- | --- |
| 1 | Preview "Open in New Window" รันนอก sandbox | security |
| 2 | JS runner รายงานว่าจบเร็วเกินไป / ไม่ track `fetch` body | correctness |
| 3 | dynamic `import()` ที่ใช้ template literal ทำให้การรันพัง | correctness |
| 4 | Replace All แทนที่มากกว่าที่ผลค้นหาแสดง | correctness |
| 5 | Preview ไม่สนใจ import map ของหน้าเอง | correctness |
| 6 | Persistence ของ unsaved buffer ค้าง (stale) หลัง rename/delete | data loss |
| 7 | การอ่าน storage ล้มเหลวแล้วเขียนทับโปรเจกต์ด้วย sample project | data loss |
| 8 | Preview ปลอม key press เพื่อสั่งงานคำสั่งของ IDE ได้ | security |
| 9 | tree re-render ลบชื่อที่กำลังพิมพ์เมื่อ auto save ทำงาน | UX |

ข้อ 1 และ 8 เกี่ยวกับขอบเขต sandbox ของ preview โดยตรง และต้องปิดก่อนที่ runner จะถูก ship ในแอปที่ผ่าน store review; ข้อ 6 และ 7 เกี่ยวกับ storage ซึ่งเป็นสิ่งที่ย้ายไป Rust SQLite ใน mobile พอดี จึงควรแก้ให้ถูกใน model ก่อนย้าย

---

## 10. Roadmap

ระยะเวลาเป็น solo เต็มเวลา; ทีม 3–5 คนทำ desktop daily-driver ได้ใน 6–8 สัปดาห์, mobile ~4 เดือน, 1.0 ใน 5–6 เดือน ทุก phase ต้องส่งของที่ใช้งานได้จริงและมี exit criteria เป็นตัวเลข

### P0 — Spike และ go/no-go (3–4 สัปดาห์) — แก้ bug 9 รายการของ some-ide ก่อน

**เป้าหมาย**: พิสูจน์ 5 จุดเสี่ยงก่อนผูกมัด — blocks บน VS Code terminal, block events ฝั่ง server ใน somed, CodeMirror touch/Thai editing ใน Tauri Android shell, Android forkpty + bundled zsh ภายใต้ W^X, และ pairing โทรศัพท์-laptop — พร้อมบันทึกตัวเลข

**Deliverables**
- Code-OSS 1.141 fork build ได้บน OS ของนักพัฒนาและใน CI (macOS/Linux) พร้อม product.json overlay (ชื่อ, ไอคอน, Open VSX) และ stub Thai language pack
- Prototype `terminalContrib/blocks` แสดงคำสั่งที่จบแล้วจาก `ICommandDetectionCapability` พร้อม copy/rerun และ raw-grid toggle บน zsh, bash, pwsh; 20 scripted command sequences เป็น test
- somed prototype: PTY + inject VS Code shell-integration scripts + `@xterm/headless` command detection ปล่อย block events; fs read/write/watch ผ่าน WebSocket; QR device pairing ด้วย Ed25519 + TLS
- Tauri 2 Android app: CM6 editor + TextMate highlighting, explorer ของ some-ide, DOM block list ต่อกับ somed ผ่าน LAN; Rust forkpty ของ /system/bin/sh และ cross-compiled `libzsh.so` exec จาก nativeLibraryDir บนเครื่องระดับ Pixel; iOS build smoke test บน Mac (ของตัวเองหรือ cloud runner)
- Device matrix: พิมพ์/เลือกข้อความไทยบน Monaco (desktop), CM6 + Gboard (Pixel), CM6 + iPhone Thai keyboard; xterm WebGL perf ใน WKWebView/Android WebView; SQLite-vs-IndexedDB durability test; seed terminal conformance corpus
- Monorepo (pnpm workspaces) พร้อม `@some/*` packages scaffold; cargo-deny + npm license allow-list ใน CI; **แก้ bug 9 รายการใน §9.4**

**Exit criteria**: blocks ถูกต้องสำหรับ 20 scripted sequences บน 3 shells; โทรศัพท์แก้ไฟล์บน laptop และรัน `ls`/`npm test` เป็น blocks ได้; local zsh blocks รันบนเครื่อง Android; ข้อความไทยพิมพ์และแก้ได้ถูกต้องบน editor ทั้งสาม; go/no-go memo (Tauri mobile vs Capacitor/Expo fallback) พร้อมตัวเลขที่วัดได้

### P1 — Release แรกที่ใช้ได้: Desktop Alpha (OS ของนักพัฒนา + Linux; Windows ไม่เซ็น) และ Android Alpha (sideload / Play internal testing) (10–12 สัปดาห์)

**เป้าหมาย**: branded VS Code ที่ใช้ได้ทุกวันพร้อม block terminal และ terminal AI บวกแอป Android ที่แก้ไข ค้นหา commit และรันคำสั่งได้ทั้ง local (mksh/zsh blocks) และบนเครื่องผู้ใช้ผ่าน somed

**Deliverables**
- Desktop: blocks v1 (navigate, collapse, select/copy output, rerun, bookmark, share เป็น Markdown/JSON, TUI raw mode), input editor v1 (หลายบรรทัด, Terminal Suggest completions, fuzzy history), terminal AI v1 (Explain error, NL→command พร้อม preview; BYOK Anthropic/OpenAI/Google/OpenRouter/Ollama), Scratch Runner extension จาก some-ide, auto-update channel, Open VSX gallery, ปุ่ม "host mode" ที่เริ่มและ pair somed
- somed v1: sessions พร้อม persistence/replay, fs/watch, ripgrep search, git status/diff/stage/commit, workflows list, pairing + TLS, installers สำหรับ macOS/Linux/Windows และ Docker image
- Android app v1: explorer, CM6 editor + VS Code themes/grammars, search/replace, quick open/command palette, **LOCAL blocks terminal** (mksh + bundled zsh, extra-keys bar, session tabs), remote somed sessions, offline mirror ของโฟลเดอร์ที่เปิดพร้อม diff3 merge, git status/commit, sandbox runners + bundled Pyodide
- CI: desktop builds 3 OS (Windows ไม่เซ็น), Android AAB (target 36, 16 KB pages), Vitest/Playwright/Rust/conformance tests, upstream-merge playbook; **สั่ง Windows OV certificate ตอนนี้**

**Exit criteria**: ผู้สร้างใช้ desktop build เป็น editor/terminal เดียว 2 สัปดาห์ และแอป Android ทุกวัน 1 สัปดาห์; external testers 20 คน; crash-free sessions > 99%; merge upstream ไป VS Code stable ถัดไปเสร็จใน ≤ 3 วัน; `cat` ไฟล์ 200 MB ไม่ทำให้ UI ใดค้าง

### P2 — iOS, SSH ทุกที่, release engineering (8–10 สัปดาห์)

**เป้าหมาย**: ผลิตภัณฑ์เดียวกันบน 5 OS พร้อม signing ระดับ store, plain-SSH host ที่ไม่มี somed, LSP บน mobile และส่ง App Store review เร็วเพื่อเรียนรู้ท่าทีของ Apple

**Deliverables**
- iOS/iPadOS app ผ่าน TestFlight ถึงการส่ง App Store ครั้งแรก (Xcode 26 SDK, bundled Pyodide, ไม่มี network package install, preview เปิดใน Safari, Sandbox shell ที่ติดป้าย, app container มองเห็นใน Files ผ่าน UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace); เก็บ build variant ที่ไม่มี runner ไว้เป็น fallback
- Windows OV code signing, macOS notarization, Flathub listing, Play production listing; BIS encryption self-classification; PDPA privacy notice พร้อม opt-in telemetry
- russh SSH client ในแอปและ `ssh` bootstrap บน desktop: inject VS Code scripts บน host bash/zsh/fish (temporary ZDOTDIR / --rcfile / XDG_DATA_DIRS, implementation ของเราเอง), pwsh profile snippet สำหรับ Windows host, heuristic blocks fallback; somed auto-upload ผ่าน SSH เมื่อ host ไม่มี
- LSP บน mobile ผ่าน somed proxy (TS/JS, Python, clangd) พร้อม Problems view; git branches/pull/push บน mobile; tasks.json tasks เป็น blocks
- Workflows/snippets (Warp YAML import + VS Code snippet JSON), terminal split/tabs บน tablet, settings/keybindings subset sync, UI ไทยสำหรับ mobile, Intl.Segmenter Thai word navigation
- คู่มือ Tailscale roaming; mDNS discovery บน LAN; ตรวจการย้าย CocoaPods→SwiftPM ของ Tauri iOS project

**Exit criteria**: ได้รับ App Store approval อย่างน้อยหนึ่งครั้ง; workspace เดียวถูกแก้จาก Windows, macOS, iPhone และ Android ภายในวันเดียว; block ที่ export จากโทรศัพท์ render เหมือนกันบน desktop; SSH ไป Ubuntu box มาตรฐานแสดง blocks โดยไม่แตะ rc files ของมัน

### P3 — AI chat และ agent mode, tablet Full workbench, desktop ภาษาไทย (10 สัปดาห์)

**เป้าหมาย**: agent mode แบบ Warp และ chat แบบ VS Code บน desktop, agent เดียวกันสั่งจากโทรศัพท์พร้อม approvals และ VS Code workbench เต็มบน tablet

**Deliverables**
- Desktop some-ai เป็น defaultChatAgent: chat view, inline chat, agent loop ที่มี file/terminal tools และ approvals, MCP servers จาก core, ACP host presets สำหรับ CLI agents พร้อม `terminal/*` client methods ที่ implement บน blocks
- somed agent sessions (loop เดียวกัน + ACP) stream ไป mobile พร้อม diffs, permission prompts และ push notification (optional)
- Tablet "Full workbench" mode: vscode-reh-web ของ fork ที่ somed เสิร์ฟภายในแอป mobile สำหรับผู้ใช้คีย์บอร์ด (extensions รันบน host)
- Desktop Thai language pack (~3k string ที่เห็นบ่อยที่สุด) publish บน Open VSX; tree-sitter-wasm offline outline/breadcrumbs บนโทรศัพท์

**Exit criteria**: จากโทรศัพท์ สั่ง agent ที่แก้โค้ดและรัน test บน laptop พร้อม approvals ได้; iPad + คีย์บอร์ดติดตั้งและใช้ Open VSX extension ผ่าน somed ได้; UI ไทยครอบคลุม command palette, settings และ terminal บน desktop

### P4 — Debugging, local files, polish → 1.0 (10 สัปดาห์)

**เป้าหมาย**: ปิดช่องว่าง parity ที่เหลือและบรรลุ performance budget สำหรับ 1.0 ทุกช่องทาง

**Deliverables**
- Mobile debugging (DAP proxy: js-debug, debugpy; CodeLLDB) พร้อม breakpoints, stepping, variables, console
- iOS document-picker folders และ Android SAF import/export; multi-root; outline/breadcrumbs จาก LSP; multi-cursor และ diff polish บน mobile; runbooks (Markdown ที่มี fenced block รันได้)
- Performance: virtualised blocks, output 100k บรรทัด, cold start < 2 วิ บน mobile, memory budgets; terminal theme import (iTerm2/Ghostty/Windows Terminal); data-pack extensions บน mobile
- devcontainer support บน desktop ด้วย REH ของเราและ somed ใน container; accessibility pass ทั้งสอง UI; security review ของ somed ก่อนมี public relay ใด ๆ

**Exit criteria**: 1.0 เผยแพร่บน App Store, Play, Flathub, winget/Homebrew/direct; perf budgets ผ่านบนโทรศัพท์ระดับ Pixel 7 และ laptop ปี 2019; ภาระ support จัดการได้โดยคนเดียว (< 2 ชม./วัน)

### P5 — หลัง 1.0 (optional, ตามความต้องการ; ต่อเนื่อง)

**เป้าหมาย**: ตัวสร้างความต่างที่ต้องการ infrastructure หรือมีความเสี่ยงด้านนโยบาย เลือกจากข้อมูลการใช้งาน

**Deliverables**
- First-party end-to-end-encrypted relay + block share links (PDPA notice); push notification ผ่าน relay
- somed เปิดเพิ่มเป็น plain SSH endpoint ให้ Blink/Termius/ssh client ใดก็ได้ attach session ถาวรเดียวกัน; Yjs live co-editing; iOS File Provider extension
- Android sideload build พร้อม opt-in proot environment (ไม่อยู่ใน Play build เด็ดขาด); in-process CPython บนโทรศัพท์แทน Pyodide-in-WebView
- Windows ARM64 และ Linux arm64 desktop builds; ภาษาไทยครบบน desktop

**Exit criteria**: แต่ละรายการ ship หลัง flag พร้อม usage metric ของตัวเอง; ไม่มีรายการใดขวาง upstream merge รายเดือน; กัน 15–20% ของเวลาไว้สำหรับ merges, SDK churn และ store compliance

### สรุประยะเวลา

| Phase | ระยะเวลา (solo) | สะสม | ผลลัพธ์ที่ใช้งานได้ |
| --- | --- | --- | --- |
| P0 | 3–4 สัปดาห์ | ~1 เดือน | go/no-go memo + bug 9 รายการปิด |
| P1 | 10–12 สัปดาห์ | ~3–4 เดือน | Desktop alpha + Android alpha |
| P2 | 8–10 สัปดาห์ | ~5–6 เดือน | iOS บน App Store, signed builds, SSH ทุกที่ |
| P3 | 10 สัปดาห์ | ~8 เดือน | agent mode, tablet Full workbench, Thai desktop |
| P4 | 10 สัปดาห์ | ~10 เดือน | 1.0 ทุกช่องทาง |
| P5 | ต่อเนื่อง | — | relay, Yjs, proot sideload, ARM builds |

---

## 11. ความเสี่ยงและการลดความเสี่ยง

| # | ความเสี่ยง | การลดความเสี่ยง |
| --- | --- | --- |
| 1 | blocks และ input-editor contribs ใช้ VS Code internals ที่ไม่ public (`ICommandDetectionCapability`, terminal view layout) ซึ่งเปลี่ยนทุก release รายเดือน | ห่อ contrib ทั้งสองด้วย thin adapter; รัน VS Code test runner บน 20 scripted shell sessions; merge ทุก stable tag ภายใน 3 วัน; งบ maintenance 15–20% ตั้งแต่วันแรก; ship โดยปิด blocks ด้วย flag แทนการข้าม upgrade |
| 2 | blocks บน xterm grid เป็น lossy: `clear`, prompt ที่ redraw (p10k), scrollback trimming และคำสั่งที่รันนานทำให้ขอบเขตเบลอ | freeze block หลัง OSC 633 D เท่านั้นโดยใช้ `ITerminalCommand.getOutput()` และ command line ที่ยืนยันด้วย nonce; raw-grid toggle และ auto-switch บน alternate buffer; ทดสอบ shells ชุดเดียวกับที่ VS Code ทดสอบ; persist block log ใน somed แทนการพึ่ง scrollback; terminal conformance corpus ใน CI |
| 3 | xterm.js ไม่มี mobile touch/selection/IME (issue #5377 เปิดอยู่; maintainers: "non-existent", "not a priority") → live terminal บนโทรศัพท์จะแย่กว่า Termius/Blink ในช่วงแรก | output ที่จบแล้วเป็น DOM (native selection/copy/share) เพื่อให้ xterm ถือเฉพาะ live block; สร้าง extra-keys bar และ touch layer ขั้นต่ำใน P0/P1; ถือว่า TUI เต็มรูปแบบบนโทรศัพท์ "ใช้ได้ ไม่ polished" |
| 4 | Apple review ภายใต้ 2.5.2 (downloaded/executed code) และ 4.2.7(e) (thin clients); dossier รายงานว่าอัปเดตของ Replit ถูกระงับ 2 เดือนในปี 2026 (ยืนยันซ้ำไม่ได้) | วางตำแหน่งแอปเป็น editor + SSH/remote terminal ไปเครื่องของผู้ใช้เอง; offline runners รันเฉพาะโค้ดที่ผู้ใช้เขียนและมองเห็นได้ โดย Pyodide bundle และปิด network package install; preview เปิดใน Safari; ไม่มี extension host หรือ VSIX execution บน iOS; ส่ง TestFlight/App Store เร็วใน P2 และเตรียม iOS build variant ที่ไม่มี runner |
| 5 | Google Play policy (ห้าม native code ที่ดาวน์โหลด, target API 36, 16 KB pages) และ SAF performance cliff; ตัวบทนโยบายดึงซ้ำไม่ได้ในรอบนี้ | ไม่มี package manager ใน Play build (เฉพาะ bundled libzsh.so exec จาก nativeLibraryDir ตามที่เอกสาร W^X ของ Android 10 อนุญาต), workspace ใน app-private storage + SAF import/export, native libs build 16 KB-aligned ใน CI, proot เฉพาะ sideload build |
| 6 | Tauri mobile maturity: plugin fs/shell/process/websocket บน iOS/Android ยังไม่ครบ (process = none, fs/shell = partial), iOS tooling ยังผ่าน CocoaPods (trunk read-only ธ.ค. 2026), Xcode/SDK churn รายปี | ทำ fs/PTY/SSH/git ใน Rust core ไม่ผ่าน plugin; WebSocket ผ่าน browser API; pin Tauri minors; `HostBridge` interface ให้ย้าย UI ไป Capacitor/Expo ได้; งบ maintenance 1 สัปดาห์/ไตรมาส; ตรวจ SwiftPM migration ใน P2 |
| 7 | การแก้ไขข้อความไทยถดถอยใน CodeMirror 6 บน Android WebView (Gboard composition) หรือใน block text (combining marks, word selection) | P0 device matrix พร้อม scripted Thai typing/selection tests; Intl.Segmenter สำหรับ word navigation; Thai/CJK golden tests ใน CI; ปิด EditContext ใน CM6; โหมด "plain text" fallback ต่อไฟล์เป็นทางหนี; รายงาน upstream |
| 8 | Bandwidth ของคนเดียว: VS Code fork, Rust/Tauri mobile app และ daemon คือ 3 ผลิตภัณฑ์ | phase gates เข้มงวดและทุก phase มี release ที่ใช้ได้; ฟีเจอร์อยู่หลัง flag; tablet Full-workbench mode เป็นทางหนีด้าน parity; ใช้ upstream contribs (suggest, history, sticky scroll, chat) แทนการเขียนใหม่; เลื่อน relay/CRDT จนกว่ามี demand; กัน 15–20% ของเวลาสำหรับ merges และ store compliance |
| 9 | somed คือ remote code execution โดยธรรมชาติ; pairing ที่อ่อนแอจะเปิดเครื่องของผู้ใช้ | Ed25519 device-key pairing ผ่าน QR, TLS พร้อม pinned certs, ไม่มี password auth, bind กับ localhost/LAN/Tailscale โดยปริยาย, revoke รายอุปกรณ์, audit log ของคำสั่ง, versioned protocol, external security review ก่อนมี public relay |
| 10 | AI: พึ่ง GitHub Copilot services จาก fork เป็นความเสี่ยง ToS; ต้นทุน provider อาจทำให้ผู้ใช้ตกใจ | ไม่ route ไป Copilot services; ship default chat participant ของเราเองพร้อม BYOK providers และ local models (Ollama); แสดงประมาณการ token/cost ต่อ request; โค้ด in-tree MIT `extensions/copilot` ใช้เป็นแบบอ้างอิงเท่านั้น |
| 11 | Trademark และ copyleft contamination: "Visual Studio Code", "Warp", AGPL Warp client, GPLv3 Ghostty/kitty shell scripts (ยืนยันแล้ว), GPL Blink/Termux/mosh/iSH, VS Code Server/Remote extensions และ Marketplace ที่เป็น proprietary | ชื่อ/ไอคอนของเราเองและใช้ถ้อยคำเชิงบรรยาย "VS Code-compatible" เท่านั้น; cargo-deny + npm license allow-list ใน CI; ใช้เฉพาะ MIT scripts ของ VS Code หรือ clean-room OSC 133/633; build REH เองและใช้ Open VSX; แทน Microsoft-only extensions ด้วย basedpyright, clangd, CodeLLDB, open-remote-ssh |
| 12 | Windows code signing จากไทย: Azure Trusted/Artifact Signing eligibility ยืนยันไม่ได้ (รอบที่ 1: บุคคลธรรมดาต้องอยู่ US/Canada; รายชื่อประเทศสำหรับองค์กรไม่มีไทย); เงื่อนไขหรือความพร้อมของ Open VSX อาจเปลี่ยน (free tier ไม่ได้ตั้งใจสำหรับ commercial offerings; Managed Registry แบบเสียเงินเปิดตัว 2026-04-21) | สั่ง OV certificate ใน P1 ให้พร้อมใน P2 และเผยแพร่ผ่าน winget/Scoop พร้อม hash ระหว่างนั้น; extensionsGallery ตั้งค่าได้ + caching mirror สำหรับ extension ของเราเอง + manual VSIX path ที่มีเอกสาร; อ่านเงื่อนไข Open VSX ซ้ำก่อน 1.0 และตัดสินใจเรื่อง tier/self-host ตามโมเดลธุรกิจ (§12) |
| 13 | iOS suspend แอป ~20–30 วิ หลัง background; ผู้ใช้เสีย session ที่กำลังรันและ output ของ agent | sessions, scrollback และ agent runs อยู่ที่ somed พร้อม resumable streams และ sequence numbers; optional tmux auto-attach สำหรับ plain SSH host; push notification เมื่อเสร็จ; ไม่ใช้ location-services keepalive hack |

---

## 12. การตัดสินใจ

### 12.1 ตัดสินแล้ว (DECIDED — 2026-10-16)

| # | หัวข้อ | การตัดสินใจ | ผลที่ตามมา |
| --- | --- | --- | --- |
| D1 | ขอบเขตแพลตฟอร์มและ terminal บน iOS | **รองรับทุกแพลตฟอร์มรวม iOS**; terminal บน iOS = remote (somed/SSH) + Sandbox shell ที่ติดป้ายชัดเจน; Android และ desktop = local terminal | ปลดล็อก P2; ต้องสื่อสารกับผู้ใช้ตรง ๆ ว่า iPhone/iPad ไม่มีวันมี local shell (กฎของ Apple ไม่ใช่ทางเลือกออกแบบ); ฟีเจอร์ offline (editor, git, runners) ต้องเป็นของจริงเพื่อผ่าน 4.2.7(e) |
| D2 | สถาปัตยกรรมหลัก | **Desktop = branded Code-OSS fork + blocks terminal; mobile = Tauri 2 app; phone-first, tablet "Full workbench" mode ภายหลัง (P3)** | รับภาษี upstream-merge 15–20%/เดือน และ 3 codebases (fork, somed, mobile); งาน touch/Thai/offline ถูกบังคับให้ทำเร็ว (P0 gate); tablet mode ราคาถูกภายหลังเพราะเป็น reh-web build เดียวกับที่ somed เสิร์ฟอยู่แล้ว; UI mobile เขียนหลัง `HostBridge` เผื่อย้ายไป Capacitor/Expo ถ้า Tauri mobile สะดุดที่ P0 |
| D3 | แหล่ง compute | **เครื่องของผู้ใช้เอง** (somed daemon + SSH; Tailscale สำหรับ roaming); first-party relay เป็น optional ใน P5; **ไม่มี hosted multi-tenant cloud** | ไม่มีต้นทุน ops; แอปอยู่ในหมวด SSH client ที่ Apple ยอมรับ; somed ต้อง ship พร้อม Ed25519 pairing + TLS ใน P1 ไม่ว่าอย่างไร |
| D4 | โมเดลธุรกิจและ license | **Open-core**: โค้ด (desktop fork, somed, mobile app) ภายใต้ MIT/Apache-2.0 | ตรงกับ license ของทุก dependency (VS Code, xterm.js, CodeMirror, Tauri, russh, libgit2 exception); แจกผ่าน App Store ได้ไม่มีปัญหา (GPL ใช้ไม่ได้ในทางปฏิบัติ); รายได้ (ถ้ามี) จากแอป store แบบเสียเงิน, relay/sync subscription และ support เป็นเรื่องที่ตัดสินภายหลัง |
| D5 | ชื่อผลิตภัณฑ์ | **Codename คงเป็น `some-ide`**; ชื่อจริงเลือกก่อน P1 alpha; **ห้ามมี** "VS Code", "Visual Studio" หรือ "Warp" | ก่อน alpha สาธารณะต้อง rebrand fork ทั้งหมด (ไอคอน, product.json, store listings) และตรวจ trademark (App Store/Play/npm/domain และการจดทะเบียนกับกรมทรัพย์สินทางปัญญา); identifier (applicationName, dataFolderName, bundle/App IDs, URL protocol) ถูก bake ลง installer และโฟลเดอร์ข้อมูลผู้ใช้ จึงเปลี่ยนหลัง release ไม่ได้ |
| D6 | iOS build infrastructure | **ต้องมี Mac (ของตัวเองหรือ cloud runner) และ Apple Developer account ก่อน P2** | Xcode 26 บน macOS เท่านั้นที่ build และอัปโหลด App Store ได้; ถ้าไม่มี milestone iOS ใน P2 จะเลื่อนหรือต้องพึ่ง cloud runner แบบเสียเงิน |

### 12.2 คำถามที่ยังเปิดอยู่

| # | คำถาม | ทางเลือก | ควรตัดสินเมื่อ |
| --- | --- | --- | --- |
| O1 | มี telemetry หรือไม่ | ไม่มีเลย / opt-in พร้อม PDPA privacy notice (แผนตั้งไว้เป็น opt-in ใน P2) | ก่อน P2 (ต้องเขียน privacy notice และ store listing) |
| O2 | รูปแบบรายได้ภายใต้ open-core | แอป mobile บน store แบบเสียเงิน (Code App ขายได้ที่ US$6.99 ทั้งที่เป็น MIT) / relay+sync subscription (P5) / support / ฟรีทั้งหมด | ก่อน P2 (เกี่ยวกับ store listing และ Open VSX tier ด้านล่าง) |
| O3 | Open VSX tier | ถ้าผลิตภัณฑ์นับเป็น commercial offering free tier (< 3 RPS, "not intended for commercial offerings") อาจไม่พอ → Enterprise tier / self-host registry / caching mirror; ตัวเลขราคาเห็นผ่าน search snippet เท่านั้น (**ต้องตรวจเอง**) | ก่อน 1.0; อ่านเงื่อนไขซ้ำเมื่อ O2 ชัด |
| O4 | ชื่อจริง | ชื่อรากไทย (ข้อเสนอใช้ ศาลา/Sala และ แก่น/Kaen เป็น placeholder) / ชื่ออังกฤษ | ก่อน P1 alpha (ตาม D5) |
| O5 | Mac ของตัวเอง vs cloud macOS runner (GitHub Actions/Codemagic) | ซื้อ Mac (ต้นทุนครั้งเดียว, debug บนเครื่องได้) / cloud runner (ต้นทุนต่อเนื่อง, debug ยาก) | ก่อน P2 (ตาม D6); P0 ใช้ cloud runner สำหรับ smoke test ได้ |
| O6 | ภาษา/curated packs ที่เน้นใน P1–P2 | รอบที่ 1 แนะนำ TS/JS + Python + C/C++ (เหมาะกับการศึกษาและ bootcamp ไทย; clangd + CodeLLDB) / TS/JS + Python + Go หรือ Rust (นักพัฒนามืออาชีพ) | ก่อน P1 (กำหนดว่า LSP server ใดต้องทดสอบบน somed และ Open VSX) |
| O7 | Android sideload/F-Droid build พร้อม proot | ทำใน P5 ตาม demand / ไม่ทำเลย (ลดพื้นที่ความเสี่ยงด้านนโยบาย) | หลัง 1.0 จากข้อมูลการใช้งาน |
| O8 | Windows signing path | OV certificate จาก CA (แผนหลัก) / ตรวจ Azure Artifact Signing ภายใต้ชื่อใหม่อีกครั้งหากจดนิติบุคคลไทย (**ต้องตรวจเอง**) | P1 (ต้องสั่ง certificate ตอน P1 เพื่อให้พร้อม P2) |

---

## 13. ผลการตรวจสอบข้อเท็จจริง

สถานะ: **ยืนยัน** = ตรวจจาก primary source แล้ว, **แก้ไขบางส่วน** = ข้ออ้างหลักถูกแต่มีส่วนที่ผิด, **หักล้าง** = ส่วนสำคัญผิด, **ต้องตรวจเอง** = primary source เข้าถึงไม่ได้ในสภาพแวดล้อมที่ตรวจ ห้ามอ้างอิงจนกว่าจะตรวจซ้ำ

### 13.1 รอบที่ 2 (ทุกแพลตฟอร์ม + Warp terminal) — 20 รายการ

| # | ข้ออ้าง | สถานะ | การแก้ไข / แหล่งอ้างอิง |
| --- | --- | --- | --- |
| 1 | microsoft/vscode stable ล่าสุด 1.141.0 (7 ต.ค. 2026), MIT; main เป็น 1.142.0; `.npmrc` pin Electron 43.7.7, `.nvmrc` pin Node 24.18.0 | ยืนยัน | ทุกค่าตรง; package.json บน main เขียน "1.142.0" ตรง ๆ ("-dev" เป็นเพียง label ตามธรรมเนียม); releases/latest, vscode-docs v1_141.md, release/1.141 package.json, .npmrc, .nvmrc |
| 2 | `capabilities.ts` นิยาม `ICommandDetectionCapability` และ `ITerminalCommand.getOutput()`; terminalContrib มี suggest, history, stickyScroll, commandGuide, chat; v1.107 ระบุ Terminal Suggest เปิดสำหรับ stable; `gulpfile.reh.ts` ปล่อย reh-web bundles | ยืนยัน | ถูกต้อง มีหมายเหตุเรื่องชื่อ gulp: ชื่อ task สร้างจาก `vscode-${type}${platform}${arch}${minified}` → task minified เช่น `vscode-reh-web-linux-x64-min` แต่โฟลเดอร์ผลลัพธ์คือ `vscode-reh-web-linux-x64` (ไม่มี `-min`); terminalContrib มีโฟลเดอร์อื่นอีกมาก (accessibility, find, links, quickFix ฯลฯ) |
| 3 | shell-integration scripts ของ VS Code เป็น MIT และปล่อย OSC 633 A/B/C/D/E/P; docs ระบุ bash/fish/pwsh/zsh (Windows: Git Bash, pwsh) และ auto-injection ใช้ไม่ได้ใน plain ssh/sub-shell; scripts ของ Ghostty สำหรับ bash/zsh เป็น GPLv3 (มาจาก kitty) | ยืนยัน | script ปล่อย F, G และ EnvSingle* เพิ่มด้วย (A/B/C/D/E/P เป็น subset ที่ถูกต้อง); header ของ `ghostty.bash` และ `ghostty-integration` (zsh) ระบุ GPLv3 ชัดเจน |
| 4 | App Store 2.5.2 ห้ามดาวน์โหลด/ติดตั้ง/execute โค้ด (ยกเว้น educational ที่ source ดู/แก้ได้); 4.2.7(e) thin clients ไม่เหมาะสม; Apple DTS ระบุ iOS apps spawn child process ไม่ได้; ต้องใช้ Xcode 26 / iOS 26 SDK ตั้งแต่ 28 เม.ย. 2026 | ยืนยัน | ตรวจถ้อยคำตรงตัวจาก guidelines, forum thread 747499 (DTS Engineer, ก.พ. 2024: "iOS apps are not allowed to spawn child processes") และ news/upcoming-requirements |
| 5a | Google Play บังคับ target API 36 ตั้งแต่ 31 ส.ค. 2026 (ขยายได้ถึง 1 พ.ย. 2026); Android 10 W^X ห้าม execve ไฟล์ใน home directory และให้ load เฉพาะ binary ใน APK; Termux Play build ใช้ minSdk 30 / targetSdk 37 | ยืนยัน | ถูกต้อง; แก้ path repo: ที่ถูกคือ `github.com/termux-play-store/termux-apps` (ไม่ใช่ `termux/termux-play-store` ซึ่ง 404) |
| 5b | ถ้อยคำนโยบาย Play: ห้ามดาวน์โหลด executable code (dex, JAR, .so) จากแหล่งอื่นนอก Play | ต้องตรวจเอง | หน้านโยบาย (answer/9888379, play.google) ถูกบล็อก DNS; มีเพียงหลักฐานทางอ้อมจากหน้า dynamic-code-loading ของ developer.android.com ว่าการโหลดโค้ดจาก remote ละเมิดนโยบาย Play; ประโยค "dex, JAR, .so" ยังมาจาก dossier/ความจำ |
| 6 | Tauri 2: @tauri-apps/cli 2.12.1 (Apache-2.0 OR MIT); ตาราง plugin ระบุ fs/shell/process/websocket เป็น "?" (untested) บน mobile; sql/store/dialog/clipboard-manager/http/notification/deep-link/biometric รองรับ; updater ไม่รองรับ; default iOS 15.0 / Android minSdk 24; iOS ต้องใช้ Xcode + CocoaPods บน macOS | หักล้าง (ส่วนตาราง plugin) | ยืนยัน: เวอร์ชัน/license, defaults ใน config.schema.json, prerequisites (Xcode + CocoaPods); **หักล้าง**: ตารางมีเฉพาะระดับ full/partial/none ไม่มี "?"; ที่ commit ที่ docs pin: fs = partial (จำกัดที่ Application folder), shell = partial (เปิด URL ผ่าน `open` เท่านั้น), process = none, websocket = full, sql/store/http/notification/biometric = full, dialog/clipboard-manager/deep-link = partial, updater = none; README ของ sql ระบุ iOS "x" ขัดกับ metadata (ความไม่สอดคล้องภายใน) — การออกแบบ (ทำ fs/PTY/SSH ใน Rust) ยังถูกต้อง |
| 7 | Monaco README FAQ ตอบ "No." สำหรับ mobile; @codemirror/view 6.43.14 และ @codemirror/lsp-client 6.3.0 เป็นปัจจุบันและ MIT | ยืนยัน | README บรรทัด 104–106; npm latest (view 2026-10-07, lsp-client 2026-09-17) |
| 8 | @xterm/xterm และ @xterm/headless 6.0.0 (MIT); issue #5377 เปิดอยู่ maintainers กล่าวว่า mobile support "non-existent" และ "definitely not a priority" | ยืนยัน | ชื่อเต็ม issue: "Limited touch support on mobile devices impacts terminal usability" (เปิด 2025-07-20); คำพูดสองประโยคมาจาก maintainer สองคน (jerch, Tyriar); 6.1.0-beta มีใน tag beta |
| 9 | russh 0.64.1 (Apache-2.0, 5 ต.ค. 2026), portable-pty 0.9.0 (MIT), git2 0.21.0, just-bash 3.6.0 (Apache-2.0) เป็นปัจจุบัน; libc crate ประกาศ forkpty/openpty ใน linux_like/mod.rs โดยไม่ยกเว้น Android | ยืนยัน | git2 เป็น "MIT OR Apache-2.0"; ข้อยกเว้นเดียวใน libc คือ `target_env = "uclibc"` ไม่มี guard สำหรับ android |
| 10 | code-server v4.141.0 (8 ต.ค. 2026) bundle VS Code 1.141.0; FAQ อ้างเงื่อนไข Marketplace และใช้ Open VSX; VSCodium README ยืนยันเช่นกัน; open-remote-ssh เป็น MIT **ไม่มี tagged release** และมีเอกสาร serverDownloadUrlTemplate; **Eclipse Open VSX FAQ ระบุไม่มีค่าธรรมเนียม** | หักล้าง (2 ส่วน) | ยืนยัน: code-server, FAQ, VSCodium, open-remote-ssh MIT + serverDownloadUrlTemplate; **หักล้าง**: open-remote-ssh มี tag/release (v0.4.0 เป็น Latest, package.json 0.4.0); **ไม่มีหลักฐาน**: หา "Open VSX FAQ" ที่ระบุไม่มีค่าธรรมเนียมไม่พบ; wiki "Rate limiting" นิยาม Free (< 3 RPS), Enterprise (< 15), Enterprise XL (≤ 50), Platform (custom) โดยไม่ระบุราคา → ข้ออ้างที่ว่า "paid tiers ไม่มีหลักฐาน" นั้นเองก็ไม่มีหลักฐาน (รอบที่ 1 ยืนยันว่า Managed Registry เสียเงินเปิดตัว 2026-04-21 — ดู 13.2) |
| 11 | microsoft/vscode-loc มี 14 language packs และไม่มีภาษาไทย | ยืนยัน | i18n/ มี 14 รายการ (cs, de, es, fr, it, ja, ko, pl, pt-BR, qps-ploc, ru, tr, zh-hans, zh-hant); qps-ploc เป็น pseudo-localization จึงเป็น 13 ภาษาจริง |
| 12 | ACP v1 นิยาม client methods terminal/create, output, wait_for_exit, kill, release ภายใต้ capability `terminal`; @agentclientprotocol/sdk 1.8.0 (Apache-2.0) | ยืนยัน | schema/v1/meta.json และ schema.json; ข้อควรระวัง: repo มี schema/v2 แล้ว (ระบุ "v1" ชัด) และมี boolean ชื่อ `terminal` อีกตัวในบล็อก auth-methods ที่ไม่เกี่ยวกัน |
| 13 | Warp client workspace เป็น AGPL-3.0-only (warpui crates แยก); warpdotdev/workflows Apache-2.0; withfig/autocomplete MIT; vscode-codicons CC-BY-4.0; Pyodide MPL-2.0; in-tree extensions/copilot LICENSE.txt เป็น MIT | ยืนยัน | ทั้ง 6 ถูก; หมายเหตุ: warp default branch คือ `master`; warpui_core/warpui เป็น MIT ส่วนที่เหลือ AGPL v3; codicons เป็น dual (CC-BY-4.0 สำหรับไอคอน, MIT สำหรับโค้ด) ต้องให้ attribution |
| 14 | repo some-ide มี TypeScript 5,374 บรรทัด (monaco-editor ^0.57, typescript ^7.0.2, vite ^8.3.4, vitest ^5, Playwright ^1.64), breakpoint 720 px, e2e/mobile.spec.ts, โหลด Pyodide 314.0.7 จาก cdn.jsdelivr.net | ยืนยัน | 5,374 คือ `wc -l` ของ src/**/*.ts เท่านั้น (5,898 เมื่อรวม tests/e2e/config; 4,897 non-blank ใน src/); `NARROW = 720` ที่ workbench.ts:28 (และ 720 ใน settings.ts:64, editor-area.ts:235); URL ของ jsDelivr เองทดสอบไม่ได้ (proxy 403) |
| 15a | แอป iOS ของ Replit ถูกระงับ/ถอดจาก App Store ภายใต้ 2.5.2 (มี.ค.–พ.ค. 2026) | ต้องตรวจเอง | apps.apple.com ถูก proxy ปฏิเสธและ WebSearch budget หมด; ไม่มี primary source ที่เข้าถึงได้; ถือเป็นข้อมูลที่ยกมาจาก dossier (รอบ research อ้าง replit.discourse.group) |
| 15b | Azure Trusted Signing ไม่เปิดให้บุคคล/องค์กรในไทย | ต้องตรวจเอง | learn.microsoft.com เข้าไม่ได้; แหล่งรอง (README ของโปรเจกต์ third-party) กล่าวตรงกันว่าบุคคลธรรมดาต้อง US/Canada, องค์กรต้องอยู่ในรายชื่อประเทศสั้น ๆ และมีประวัติ 3+ ปี, มีการหยุดรับ onboarding บุคคลตั้งแต่ เม.ย. 2025, ผลิตภัณฑ์เปลี่ยนชื่อเป็น "Azure Artifact Signing"; ไม่มีที่ใดเอ่ยถึงไทยโดยตรง → สอดคล้องแต่ไม่พิสูจน์ (รอบที่ 1 ตรวจ Quickstart ได้ — ดู 13.2) |
| 15c | Tailscale free Personal tier ให้ 6 ผู้ใช้ | ต้องตรวจเอง | tailscale.com เข้าไม่ได้; จากความจำ (อาจล้าสมัย) free "Personal" = 3 ผู้ใช้/100 อุปกรณ์ และ 6 ผู้ใช้คือ "Personal Plus" แบบเสียเงิน (~$5/เดือน) → ตัวเลข 6 ใน dossier อาจผิด tier; ตรวจ tailscale.com/pricing ก่อนใช้ |
| 15d | CocoaPods trunk จะ read-only วันที่ 2 ธ.ค. 2026 | ยืนยัน | blog post 2024-11-30 ("CocoaPods Specs Repo"): ทดสอบ 1–7 พ.ย. 2026, สลับเป็นไม่รับ Podspec ใหม่ถาวร 2 ธ.ค. 2026; ไม่มี post ภายหลังยกเลิก; README ระบุ "maintenance mode" |
| 15e | ถ้อยคำตรงตัวของ Play "no downloaded dex/JAR/.so" | ต้องตรวจเอง | support.google.com และ play.google.com ถูก proxy ปฏิเสธ; developer.android.com/distribute/play-policies (เข้าได้) ไม่มีประโยคนี้; ถ้อยคำโดยประมาณจากความจำ: แอปห้าม modify/replace/update ตัวเองนอกกลไกของ Play และห้ามดาวน์โหลด executable code (dex, JAR, .so) จากแหล่งอื่น โดยยกเว้นโค้ดที่รันใน VM/interpreter ที่เข้าถึง Android API ทางอ้อม (เช่น JS ใน WebView) — อ้างอิงได้หลังตรวจ answer/9888379 เท่านั้น |

### 13.2 รอบที่ 1 (desktop-only) — เฉพาะรายการที่แผนสุดท้ายนำมาใช้ (fork mechanics, Open VSX, signing, web storage)

| # | ข้ออ้าง | สถานะ | การแก้ไข / แหล่งอ้างอิง |
| --- | --- | --- | --- |
| R1 | Code-OSS เป็น MIT; product.json ที่ tag 1.141.0 มี nameShort "Code - OSS", applicationName "code-oss", dataFolderName ".vscode-oss", ไม่มี extensionsGallery, webviews ชี้ vscode-cdn.net | ยืนยัน | fork ต้องแทนที่เพิ่มเติม: `defaultChatAgent` (GitHub.copilot/copilot-chat + aka.ms), `voiceWsUrl` (ของ Microsoft), `trustedExtensionAuthAccess`, `builtInExtensions` (js-debug 1.140.0 ฯลฯ จาก repo ของ Microsoft) |
| R2 | stable tag ล่าสุด 1.141.0; tags 1.137.0–1.141.0 มีครบ; VS Code ออก stable รายสัปดาห์ | ยืนยัน | release notes: 1.137 (2026-09-09), 1.138 (09-16), 1.139.1 (09-23), 1.140 (09-30), 1.141 (10-07); v1_111.md (2026-03-09) เรียกตัวเองว่า "the first of our weekly Stable releases"; อย่าอ้าง Wikipedia (ล้าสมัย 5 release) |
| R3 | vscode 1.141.0 pin Electron 43.7.7 / Node 24.18.0; Electron latest บน npm คือ 44.7.0 | ยืนยัน | 43-x-y line ไปถึง 43.7.9 แล้ว; Electron 45 อยู่ใน beta; การ bump Electron เองจะทำ native modules พัง |
| R4 | code-server มี tag v4.141.0; VSCodium ล่าสุด 1.135.06055; openvscode-server ล่าสุด v1.109.5 | ยืนยัน | VSCodium ตามหลัง upstream ~6 weekly releases และไม่ติดตามทุก stable; openvscode-server ไม่ release ~7.5 เดือน → ใช้ code-server เป็น early-warning ของ patch conflict |
| R5 | เงื่อนไข Visual Studio Marketplace จำกัดเฉพาะ In-Scope Products และห้าม scraping → fork ต้องใช้ Open VSX หรือ self-host | ยืนยัน | Terms of Use (ม.ค. 2025) §2.b และ §3; "ต้องใช้ Open VSX" เป็นข้อสรุปตามแนวปฏิบัติ (VSCodium, code-server) ไม่ใช่ถ้อยคำในเงื่อนไข; sideload VSIX ที่ build จาก source เองก็ทำได้ |
| R6 | VS Code Server ของ Microsoft host เป็น service ไม่ได้; serve-web และ tunnels อยู่ภายใต้ license นี้ | ยืนยัน | vscode-server.md FAQ และ remote/faq.md; CLI ที่ 1.141.0 เรียก `require_consent(--accept-server-license-terms)`; ส่วน "licensed per user" **ต้องตรวจเอง** (license text ถูกบล็อก) |
| R7 | Pylance, cpptools (runtime-block ตั้งแต่ v1.24.5), vsdbg, Remote-SSH/Dev Containers/WSL จำกัดเฉพาะผลิตภัณฑ์ Microsoft | ยืนยัน | Pylance FAQ, cpptools RuntimeLicenses + nativeStrings.json (เวอร์ชัน 1.24.5 มาจาก The Register), vscode-csharp debugger docs, vscode-remote-release LICENSE-extensions; C# Dev Kit และ Live Share **ต้องตรวจเอง** (license text เข้าไม่ถึง; Live Share อยู่ใน maintenance mode) |
| R8 | Open VSX ฟรีและมี rate limit | ยืนยัน | Free tier < 3 RPS (< 10,800 req/ชม.) ตอบ HTTP 429 เมื่อเกิน; OSS ขอเพิ่ม limit ได้ที่ managed.open-vsx.org/contact; tiers Enterprise (< 15), Enterprise XL (≤ 50), Platform (> 50) |
| R9 | Open VSX Managed Registry แบบเสียเงินเปิดตัว 2026-04-21 | ยืนยัน | ประกาศของ Eclipse Foundation + ข่าว; ราคา (เห็นผ่าน search snippet เท่านั้น — **ต้องตรวจเอง**): Enterprise ~100,000/ปี (MSA ระบุ €100,000) ถึง 15 RPS, Enterprise XL ~500,000/ปี ถึง 50 RPS, Platform custom; ลูกค้าแรก AWS, Google, Cursor |
| R10 | free tier ของ Open VSX ไม่ได้ตั้งใจสำหรับ commercial IDE | ยืนยัน | หน้า pricing (ผ่าน snippet): Community (Free) สำหรับ "individual developers and non-commercial users" ถึง 3 RPS และ "is not intended for commercial offerings"; นักพัฒนารายบุคคลและโปรเจกต์ open source ไม่ต้องจ่าย → ดู O2/O3 ใน §12 |
| R11 | Azure Artifact Signing (เดิม Trusted Signing) public-trust certificate: องค์กรใน US/Canada/EU/UK; บุคคลเฉพาะ US/Canada | แก้ไขบางส่วน (หักล้างรายชื่อองค์กร) | Quickstart (ms.date 2026-05-21): องค์กรใน US, Canada, EU, UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, Israel (**ไม่มีไทย**); บุคคลยังต้อง US/Canada; ไม่ใช้กับ Private Trust; การเปลี่ยนชื่อยืนยันจาก redirect file → แผนงบ OV certificate ถูกต้อง |
| R12 | ที่ tag 1.141.0 `extensions/copilot` คือ copilot-chat 0.69.0 พร้อม LICENSE.txt MIT; BYOK chat ใช้ได้โดยไม่ต้อง GitHub sign-in ตั้งแต่ 1.122 | ยืนยัน | 1.122 (2026-05-28): BYOK ใช้กับ chat, tools และ MCP เท่านั้น; inline/next-edit suggestions ยังต้อง sign-in; ต้องตั้ง chat.utilityModel เป็น BYOK เมื่อ signed out (แผนสุดท้ายใช้โค้ดนี้เป็นแบบอ้างอิงเท่านั้นและเขียน some-ai เอง) |
| R13 | WebKit ลบ script-writable storage หลัง 7 วันโดยไม่มี interaction เว้นแต่ persist | หักล้าง | `navigator.storage.persist()` สำเร็จเฉพาะโดเมนที่ได้รับยกเว้นอยู่แล้ว (app-bound, managed, embedder-persisted, Home Screen web app); ไซต์ธรรมดาได้ false; ตั้งแต่ WebKit 274398@main (ก.พ. 2024) ใช้ 7 operating days เฉพาะโดเมนที่จัดเป็น Short และ 30 operating days สำหรับ first-party อื่น → วางแผนรับ eviction หลัง ~7–30 วันที่ไม่ได้ใช้ และต้องมี sync/export path |
| R14 | TypeScript 7.0.x ship เฉพาะ native binary (ไม่มี wasm) → TS ใน browser ค้างที่ 6.0 | ยืนยัน | typescript@7.0.2 พึ่ง @typescript/typescript-<os>-<arch> 20 แพ็กเกจ; JS release ล่าสุดคือ 6.0.3; repo ใช้ ^7.0.2 สำหรับ typecheck |

---

## 14. ประวัติการตัดสินใจ

| วันที่ | เหตุการณ์ | ผลลัพธ์ |
| --- | --- | --- |
| 2026-10-09 | **รอบที่ 1 — desktop-only** ("สร้าง IDE แบบ VS Code"): research → 4 ข้อเสนอ → กรรมการ 3 คน → fact-check | ทางเลือก **A — Branded Code-OSS distribution** ชนะ 3/3 (เฉลี่ย 7.12 เทียบ B monaco-vscode-api 5.80, C own Electron workbench 5.20, D cloud 5.17) คำแนะนำ: อย่าเขียน IDE ใหม่; ship Code-OSS ภายใต้แบรนด์ของตัวเองแบบ code-server/VSCodium (pinned submodule, patch ≤ 15, product.json overlay, Open VSX); ผูกมัดเฉพาะ Desktop edition ที่เซ็นและ auto-update (P0–P2, ~6–10 สัปดาห์ solo); Lite web, Server (single-user) และ AI เป็น optional; เก็บ some-ide ไว้เป็น "Classic" สำหรับโทรศัพท์ สิ่งที่รอบนี้ยืนยันและถูกนำไปใช้ต่อ: fork mechanics, การใช้ code-server เป็น early warning, การ build REH เอง, Open VSX free tier ไม่เหมาะกับ commercial, Azure Artifact Signing ไม่เปิดให้ไทย (งบ OV certificate), WebKit storage eviction, BYOK ตั้งแต่ 1.122 ข้อจำกัด: ไม่มี mobile/terminal story และ Lite ไม่ควรแทน URL ของ some-ide เพราะจะทำผู้ใช้โทรศัพท์เสียหาย |
| 2026-10-11 | **รอบที่ 2 — ทุกแพลตฟอร์ม + terminal แบบ Warp** (14 agents; research: app-frameworks, terminal-tech, mobile-ide-landscape → 4 ข้อเสนอ A/B/C/D → กรรมการ pragmatist/ux-parity/risk → fact-check 20 รายการ: ยืนยัน 13, หักล้าง 2, ต้องตรวจเอง 5) | ทางเลือก **C — Code-OSS desktop + Tauri 2 mobile client + somed** ชนะ 3/3 (เฉลี่ย 7.0 เทียบ A 6.7, B 5.1, D 3.6) พร้อม grafts จาก A/B/D (§4.6); ตัดข้ออ้าง Ghostty MIT scripts (จริง ๆ GPLv3), Open VSX "no fees", Flutter Impeller/webview_flutter และ D ทั้งหมดในฐานะ product plan; ยืนยันกฎ iOS no-child-process และ Android W^X/Play เป็น hard constraints; กำหนด P0 gate ที่มีตัวเลขและให้แก้ bug 9 รายการของ some-ide ก่อน |
| 2026-10-16 | **การตัดสินใจของเจ้าของผลิตภัณฑ์** (เอกสารฉบับนี้) | D1–D6 ใน §12.1: รองรับทุกแพลตฟอร์มรวม iOS (remote + sandbox), Code-OSS fork + Tauri 2 (phone-first, tablet P3), compute บนเครื่องผู้ใช้ (relay optional P5, ไม่มี cloud), open-core MIT/Apache-2.0, codename `some-ide` จนกว่าจะเลือกชื่อก่อน P1 alpha, ต้องมี Mac + Apple Developer account ก่อน P2; คำถามที่ยังเปิด O1–O8 ใน §12.2 |

---
## 15. แหล่งอ้างอิง

URL ทั้งหมดที่ปรากฏในผลการวิเคราะห์ทั้งสองรอบ (ตัดซ้ำแล้ว 190 รายการ) จัดกลุ่มตามหัวข้อ; วันที่ตรวจสอบคือ 2026-10-09 (รอบที่ 1 และ 2) เว้นแต่ระบุใน §13; รายการที่ fact-check ระบุว่าเข้าถึงไม่ได้ยังคงอยู่ที่นี่เพื่อให้ตรวจซ้ำได้

### VS Code / Code-OSS / Microsoft

- <https://github.com/microsoft/vscode/releases/latest>
- <https://raw.githubusercontent.com/microsoft/vscode-docs/main/release-notes/v1_141.md>
- <https://raw.githubusercontent.com/microsoft/vscode/release/1.141/package.json>
- <https://raw.githubusercontent.com/microsoft/vscode/main/package.json>
- <https://raw.githubusercontent.com/microsoft/vscode/main/.npmrc>
- <https://raw.githubusercontent.com/microsoft/vscode/main/.nvmrc>
- <https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/common/capabilities/capabilities.ts>
- <https://github.com/microsoft/vscode/tree/main/src/vs/workbench/contrib/terminalContrib>
- <https://raw.githubusercontent.com/microsoft/vscode-docs/main/release-notes/v1_107.md>
- <https://raw.githubusercontent.com/microsoft/vscode/main/build/gulpfile.reh.ts>
- <https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh>
- <https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/terminal/shell-integration.md>
- <https://raw.githubusercontent.com/microsoft/monaco-editor/main/README.md>
- <https://github.com/microsoft/vscode-loc/tree/main/i18n>
- <https://raw.githubusercontent.com/microsoft/vscode-codicons/main/LICENSE>
- <https://github.com/microsoft/vscode-codicons>
- <https://github.com/microsoft/vscode/blob/main/extensions/copilot/LICENSE.txt>
- <https://github.com/microsoft/monaco-editor#faq>
- <https://github.com/microsoft/vscode-docs/blob/main/docs/remote/vscode-web.md>
- <https://github.com/dotnet/maui>
- <https://microsoft.github.io/react-native-windows/support>
- <https://github.com/microsoft/node-pty>
- <https://github.com/microsoft/vscode-docs/blob/main/docs/terminal/shell-integration.md>
- <https://github.com/microsoft/vscode-remote-release/issues/6325>
- <https://code.visualstudio.com/docs/remote/vscode-server>
- <https://raw.githubusercontent.com/microsoft/vscode/1.141.0/product.json>
- <https://raw.githubusercontent.com/microsoft/vscode/1.141.0/LICENSE.txt>
- <https://github.com/microsoft/vscode.git>
- <https://raw.githubusercontent.com/microsoft/vscode-docs/main/release-notes/v1_111.md>
- <https://raw.githubusercontent.com/microsoft/vscode/1.141.0/.npmrc>
- <https://raw.githubusercontent.com/microsoft/vscode/1.141.0/.nvmrc>
- <https://www.nuget.org/policies/terms>
- <https://github.com/microsoft/vscode-docs/blob/main/docs/remote/vscode-server.md>
- <https://github.com/microsoft/vscode-docs/blob/main/docs/remote/faq.md>
- <https://raw.githubusercontent.com/microsoft/vscode/1.141.0/cli/src/commands/serve_web.rs>
- <https://raw.githubusercontent.com/microsoft/vscode/1.141.0/cli/src/commands/args.rs>
- <https://github.com/microsoft/vscode-remote-release/blob/main/LICENSE-extensions>
- <https://github.com/microsoft/pylance-release/blob/main/FAQ.md>
- <https://github.com/microsoft/vscode-cpptools/blob/main/RuntimeLicenses/cpptools-LICENSE.txt>
- <https://www.theregister.com/2025/04/24/microsoft_vs_code_subtracts_cc_extension/>
- <https://github.com/dotnet/vscode-csharp/blob/main/docs/debugger/Microsoft-.NET-Core-Debugger-licensing-and-Microsoft-Visual-Studio-Code.md>
- <https://github.com/microsoft/vscode-docs/blob/main/docs/supporting/oss-extensions.md>
- <https://github.com/microsoft/vscode-docs/blob/main/docs/csharp/cs-dev-kit-faq.md>
- <https://learn.microsoft.com/en-us/visualstudio/liveshare/maintenance-mode>
- <https://tech.yahoo.com/computing/articles/visual-studio-code-vs-vscodium-113015095.html>
- <https://github.com/MicrosoftDocs/azure-docs/blob/main/articles/artifact-signing/quickstart.md>
- <https://github.com/MicrosoftDocs/azure-docs/blob/main/articles/artifact-signing/faq.yml>
- <https://github.com/MicrosoftDocs/azure-docs/blob/main/.openpublishing.redirection.json>
- <https://raw.githubusercontent.com/microsoft/vscode/1.141.0/extensions/copilot/package.json>
- <https://raw.githubusercontent.com/microsoft/vscode/1.141.0/extensions/copilot/LICENSE.txt>
- <https://github.com/microsoft/vscode-docs/blob/main/release-notes/v1_122.md>
- <https://github.com/microsoft/vscode-docs/blob/main/release-notes/v1_117.md>

### Fork และ extension registries (code-server, VSCodium, Open VSX, open-remote-ssh)

- <https://github.com/coder/code-server/releases/tag/v4.141.0>
- <https://raw.githubusercontent.com/coder/code-server/main/CHANGELOG.md>
- <https://raw.githubusercontent.com/coder/code-server/main/docs/FAQ.md>
- <https://raw.githubusercontent.com/VSCodium/vscodium/master/README.md>
- <https://raw.githubusercontent.com/jeanp413/open-remote-ssh/master/LICENSE.txt>
- <https://github.com/jeanp413/open-remote-ssh/tags>
- <https://github.com/jeanp413/open-remote-ssh/releases>
- <https://raw.githubusercontent.com/jeanp413/open-remote-ssh/master/README.md>
- <https://raw.githubusercontent.com/jeanp413/open-remote-ssh/master/package.json>
- <https://raw.githubusercontent.com/EclipseFdn/open-vsx.org/main/website/src/about.tsx>
- <https://github.com/EclipseFdn/open-vsx.org/wiki>
- <https://github.com/eclipse/openvsx/wiki>
- <https://raw.githubusercontent.com/wiki/EclipseFdn/open-vsx.org/Rate-limiting.md>
- <https://www.eclipse.org/org/workinggroups/openvsx-charter.php>
- <https://github.com/coder/code-server/releases>
- <https://github.com/VSCodium/vscodium/releases>
- <https://github.com/gitpod-io/openvscode-server/releases>
- <https://raw.githubusercontent.com/VSCodium/vscodium/master/docs/extensions.md>
- <https://github.com/VSCodium/vscodium/blob/master/docs/extensions.md#proprietary-extensions>
- <https://github.com/EclipseFdn/open-vsx.org/wiki/Rate-limiting>
- <https://github.com/EclipseFdn/open-vsx.org/blob/main/configuration/application-production.yml>
- <https://newsroom.eclipse.org/news/announcements/eclipse-foundation-launches-open-vsx-managed-registry-0>
- <https://www.manilatimes.net/2026/04/21/tmt-newswire/globenewswire/eclipse-foundation-launches-open-vsx-managed-registry/2324596>
- <https://managed.open-vsx.org/pricing/>
- <https://managed.open-vsx.org/terms/>
- <https://adtmag.com/articles/2026/05/05/eclipse-foundation-launches-managed-open-vsx-service-as-extension-registry-use-grows.aspx>
- <https://thenewstack.io/open-vsx-managed-registry/>
- <https://managed.open-vsx.org/faqs/>
- <https://registry.npmjs.org/@codingame%2fmonaco-vscode-api>
- <https://raw.githubusercontent.com/CodinGame/monaco-vscode-api/main/package.json>

### Apple / iOS / App Store

- <https://developer.apple.com/app-store/review/guidelines/>
- <https://developer.apple.com/forums/thread/747499>
- <https://developer.apple.com/news/upcoming-requirements/>
- <https://raw.githubusercontent.com/CocoaPods/blog.cocoapods.org/master/_posts/2024-11-30-CocoaPods-Specs-Repo.markdown>
- <https://github.com/CocoaPods/blog.cocoapods.org/tree/master/_posts>
- <https://github.com/CocoaPods/CocoaPods>
- <https://apps.apple.com/app/id1473805438>
- <https://mjtsai.com/blog/2020/11/09/ish-and-a-shell-vs-the-app-store/>
- <https://developer.apple.com/support/alternative-browser-engines/>
- <https://news.ycombinator.com/item?id=8953948>
- <https://apps.apple.com/dk/app/app/id6444493151>
- <https://lists.webkit.org/pipermail/webkit-gtk/2023-October/003946.html>
- <https://developer.apple.com/forums/thread/72265>
- <https://www.medianama.com/2026/04/223-apple-vibe-coding-app-ban-anythng/>
- <https://bugs.webkit.org/show_bug.cgi?id=265151>
- <https://runtimewire.com/article/wasmer-swift-sdk-ios-macos>
- <https://ish.app/blog/ish-jit-and-eu>
- <https://developer.apple.com/forums/thread/746159>
- <https://replit.discourse.group/t/apples-app-store-strict-enforcement-of-replit-submissions-as-of-march-2026/10756>
- <https://docs.termius.com/help-center/faq/how-can-i-keep-termius-sessions-alive-in-the-background-on-ios-ipados>
- <https://help.panic.com/prompt/prompt-connection-keeper/>
- <https://www.developer.apple.com/news/upcoming-requirements/>
- <https://github.com/holzschu/a-shell>
- <https://secureshellfish.app/provider.html>
- <https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/>
- <https://webkit.org/tracking-prevention/>

### Android / Google Play

- <https://developer.android.com/google/play/requirements/target-sdk>
- <https://developer.android.com/about/versions/10/behavior-changes-10>
- <https://raw.githubusercontent.com/termux-play-store/termux-apps/main/gradle.properties>
- <https://github.com/termux-play-store/termux-apps>
- <https://developer.android.com/privacy-and-security/risks/dynamic-code-loading>
- <https://support.google.com/googleplay/android-developer/answer/9888379>
- <https://developer.android.com/distribute/play-policies>
- <https://support.google.com/googleplay/android-developer/answer/16559646>
- <https://android.googlesource.com/platform/system/sepolicy/+/refs/tags/android-16.0.0_r4/private/app_neverallows.te>
- <https://gerrit.omnirom.org/plugins/gitiles/android_system_sepolicy/+/0dd738d810532eb41ad8d90520156212ce756648%5E%21>
- <https://github.com/termux/termux-app>
- <https://github.com/termux-play-store/termux-apps/releases>
- <https://code.briarproject.org/briar/briar/-/merge_requests/1279>
- <https://github.com/fornwall/termux-exec>
- <https://android.googlesource.com/platform/bionic/+/c54d307ff/libc/include/pty.h>
- <https://termux.dev/en/posts/general/2024/11/11/termux-selected-for-nlnet-ngi-mobifree-grant.html>
- <https://github.com/termux-play-store>
- <https://support.google.com/googleplay/android-developer/answer/9888379?hl=en>
- <https://developer.android.com/guide/practices/page-sizes>
- <https://developer.android.com/develop/background-work/services/fg-service-timeout>
- <https://github.com/JustinTipton/SAFTraversal>
- <https://support.google.com/googleplay/android-developer/answer/10467955>

### Tauri และ app frameworks

- <https://registry.npmjs.org/@tauri-apps/cli/latest>
- <https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/config.schema.json>
- <https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/start/prerequisites.mdx>
- <https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/packages/compatibility-table/build.ts>
- <https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/components/plugins/_helpers.ts>
- <https://github.com/tauri-apps/tauri-docs/tree/v2/packages>
- <https://raw.githubusercontent.com/tauri-apps/plugins-workspace/d4835d0e947179bac24a383212792d74be3ebe4f/plugins>
- <https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins>
- <https://github.com/tauri-apps/plugins-workspace>
- <https://v2.tauri.app/develop/debug/linux-graphics/>
- <https://github.com/electron/electron/releases>
- <https://github.com/capacitor-community/electron>
- <https://github.com/emilk/egui>
- <https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md>
- <https://kotlinlang.org/docs/multiplatform/supported-platforms.html>
- <https://github.com/ionic-team/capacitor-docs/blob/main/docs/main/updating/8-0.md>
- <https://github.com/slint-ui/slint/blob/master/CHANGELOG.md>
- <https://www.plushcap.com/content/ionic/blog/ionic-the-road-to-capacitor-9>

### Terminal, shell integration และ remote protocols

- <https://raw.githubusercontent.com/ghostty-org/ghostty/main/src/shell-integration/bash/ghostty.bash>
- <https://raw.githubusercontent.com/ghostty-org/ghostty/main/src/shell-integration/zsh/ghostty-integration>
- <https://github.com/xtermjs/xterm.js/issues/5377>
- <https://raw.githubusercontent.com/warpdotdev/warp/master/Cargo.toml>
- <https://github.com/warpdotdev/warp>
- <https://raw.githubusercontent.com/warpdotdev/workflows/main/LICENSE>
- <https://raw.githubusercontent.com/withfig/autocomplete/master/LICENSE>
- <https://tailscale.com/pricing>
- <https://docs.rs/crate/conpty-oxide/0.1.2>
- <https://docs.warp.dev/help/known-issues>
- <https://docs.warp.dev/terminal/warpify/ssh-legacy>
- <https://github.com/ghostty-org/ghostty>
- <https://mailman.mit.edu/pipermail/mosh-devel/2017-August/001502.html>
- <https://github.com/mobile-shell/mosh>
- <https://github.com/MisterTea/EternalTerminal>
- <https://tailscale.com/kb/1105/other-vpns>
- <https://github.com/blinksh/blink>

### Editors, libraries, registries (npm / crates.io)

- <https://registry.npmjs.org/@codemirror/view>
- <https://registry.npmjs.org/@codemirror/lsp-client>
- <https://registry.npmjs.org/@xterm/xterm>
- <https://registry.npmjs.org/@xterm/headless>
- <https://crates.io/api/v1/crates/russh>
- <https://crates.io/api/v1/crates/portable-pty>
- <https://crates.io/api/v1/crates/git2>
- <https://registry.npmjs.org/just-bash>
- <https://raw.githubusercontent.com/rust-lang/libc/main/src/unix/linux_like/mod.rs>
- <https://raw.githubusercontent.com/rust-lang/libc/libc-0.2/src/unix/linux_like/mod.rs>
- <https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/meta.json>
- <https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.json>
- <https://github.com/pyodide/pyodide/blob/main/LICENSE>
- <https://cdn.jsdelivr.net/pyodide/v314.0.7/full/>
- <https://registry.npmjs.org/electron>
- <https://raw.githubusercontent.com/pyodide/pyodide/main/LICENSE>
- <https://webcontainers.io/enterprise>
- <https://github.com/isomorphic-git/isomorphic-git.git/info/refs?service=git-upload-pack>
- <https://raw.githubusercontent.com/isomorphic-git/isomorphic-git/main/README.md>
- <https://raw.githubusercontent.com/github/docs/main/content/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests.md>
- <https://raw.githubusercontent.com/github/docs/main/content/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps.md>
- <https://raw.githubusercontent.com/github/docs/main/data/features/pkce_support.yml>
- <https://registry.npmjs.org/typescript/7.0.2>
- <https://registry.npmjs.org/typescript>

### อื่น ๆ

- <https://raw.githubusercontent.com/ish-app/ish/master/LICENSE.md>
