# P0 spikes — สถานะ

ผลการพิสูจน์ "ข้อต่อเสี่ยง" ทั้ง 5 จุดก่อนลงมือ P1 (ดูเกณฑ์ใน [PLAN.md §10](../PLAN.md#10-roadmap)) รายงานแต่ละเรื่องอยู่ในโฟลเดอร์นี้

| # | Spike | ทำที่ไหน | สถานะ | รายงาน |
| --- | --- | --- | --- | --- |
| 0 | แก้บั๊ก 9 ข้อของ some-ide (ฐานของแอปมือถือ) | cloud session | ✅ เสร็จ — commits `51d268a`, `c0cd091` ผ่าน unit 33 / e2e 10 และรีวิวแบบ adversarial | — |
| 0 | จัดโครง monorepo (`apps/classic`, `packages/runtime-core`) | cloud session | ✅ เสร็จ — commit `523cf1a` | — |
| 1 | Code-OSS 1.141 build ได้พร้อม `product.json` overlay (ชื่อเรา + Open VSX) | cloud session (Linux, 4 CPU, 15 GB) | 🔄 กำลังทำ | `code-oss-build.md` |
| 2 | ต้นแบบ `somed`: PTY + shell integration ของ VS Code (OSC 633) + block events + WebSocket + จับคู่ด้วย Ed25519 | `packages/somed` | 🔄 กำลังทำ | `packages/somed/README.md` |
| 3 | CodeMirror 6 บนมือถือ: ข้อความไทย, extra-keys, ประสิทธิภาพไฟล์ใหญ่ | harness (จะย้ายเข้า `apps/mobile-spike`) | ✅ ผ่าน 33/33 บน Chromium desktop + Pixel 7 emulation — ใช้ได้ โดยต้องมี Thai word extension; IME จริงต้องทดสอบบนเครื่อง (checklist 17 ข้อใน harness) | [`cm6-thai.md`](cm6-thai.md) |
| 3 | ข้อความไทยบน Monaco (desktop) | cloud session | ✅ เสร็จ | [`thai-monaco-desktop.md`](thai-monaco-desktop.md) |
| 4 | Android: `forkpty` ของ `/system/bin/sh` + zsh ที่ bundle เป็น `.so` ใต้กฎ W^X | ต้องใช้ Android SDK/NDK + เครื่องจริง | ⏳ ยังไม่เริ่ม — ทำบนเครื่องของผู้พัฒนา | — |
| 5 | จับคู่โทรศัพท์-โน้ตบุ๊ก (QR + device key + TLS) | ส่วนหนึ่งของ #2 (ฝั่ง daemon) + ต้องมีแอปมือถือ | 🔄 ฝั่ง daemon กำลังทำ | — |
| 1b | แผนที่ API ภายใน VS Code ที่ `terminalContrib/blocks` ต้องใช้ + จุดเปราะ 10 ข้อ | cloud session (อ่าน source 1.141.0) | ✅ เสร็จ | [`vscode-terminal-api-map.md`](vscode-terminal-api-map.md) |
| — | ตรวจว่า basedpyright, clangd, CodeLLDB, debugpy, Jupyter มีบน Open VSX | ต้องทำจากเครื่องที่เข้า open-vsx.org ได้ (cloud session เข้าไม่ได้) | ⏳ ยังไม่เริ่ม | — |

ข้อจำกัดของ cloud session ที่ใช้ทำ spike: ไม่มีจอ/GPU (ทดสอบผ่าน Chromium headless เท่านั้น), ไม่มี Android SDK, macOS, Xcode หรือ WebKit,
เข้า open-vsx.org และ cdn.jsdelivr.net ไม่ได้ (nodejs.org, github.com, registry.npmjs.org เข้าได้)
