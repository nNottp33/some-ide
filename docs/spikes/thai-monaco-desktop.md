# Spike: ข้อความภาษาไทยใน Monaco (desktop) — แถว desktop ของ device matrix (P0)

วันที่: 2026-10-16 · สภาพแวดล้อม: แอป Classic (`apps/classic`, monaco-editor 0.57.0) บน Chromium 1194 ผ่าน Playwright,
viewport 1200×760 · สคริปต์: `scratchpad/thai-monaco.mjs` (ไม่ได้เก็บใน repo)

ข้อจำกัดของการทดสอบ: Playwright พิมพ์ทีละตัวอักษรผ่าน key events ไม่ได้จำลอง IME composition
ของแป้นพิมพ์จริง จึงยืนยันได้เฉพาะพฤติกรรมของ editor กับข้อความไทยที่เข้ามาแล้ว ไม่ใช่การประกอบคำของ IME

## ผล

| การตรวจ | ผล | หมายเหตุ |
| --- | --- | --- |
| พิมพ์ 4 บรรทัดที่มีสระบน/ล่าง วรรณยุกต์ (สวัสดี, ผู้ใช้, น้ำ, ป้า, กรุงเทพมหานคร) แล้วอ่านกลับ | ✅ ตรงทุกตัวอักษร | ข้อความใน model เท่ากับที่พิมพ์ |
| กด → หนึ่งครั้งข้าม "น้ำ" (3 code units: น ้ ำ) | ✅ Col 7 → Col 10 | Monaco เลื่อน cursor ทีละ grapheme cluster ไม่แยกวรรณยุกต์ออกจากพยัญชนะ |
| Shift+→ เลือก "น้ำ" | ✅ เลือก 3 code units | สถานะแสดง "(3 selected)" |
| ดับเบิลคลิกคำ "สวัสดี" (มีช่องว่างคั่น) | ✅ เลือก 6 code units ตรงคำ | คำไทยที่เขียนติดกันโดยไม่เว้นวรรคจะถูกเลือกทั้งช่วง เพราะ Monaco ไม่มี word breaker ไทย (ตามแผน: ใช้ `editor.wordSegmenterLocales: ['th']` ใน VS Code fork และ `Intl.Segmenter` ใน CodeMirror) |
| Backspace ท้ายบรรทัด | ลบ 1 code unit ("ร" จาก "นคร") | เป็นพฤติกรรมเดียวกับ VS Code; การลบวรรณยุกต์ทีละตัวเป็นสิ่งที่ผู้ใช้ไทยคุ้นเคย |
| Find ในไฟล์ (Ctrl+F) ค้น "ผู้ใช้" | ✅ 1 of 1 | |
| ค้นหาข้ามไฟล์ (Ctrl+Shift+F) ค้น "สวัสดี" | ✅ 4 results in 3 files | sample project มีข้อความไทยอยู่แล้ว |
| การแสดงผล (screenshot) | ✅ ไม่มีตัวอักษรซ้อน/ขาด | ฟอนต์ fallback ของระบบ (ไม่มี Noto Sans Thai ในเครื่องทดสอบ) |

## สิ่งที่ต้องตรวจบนอุปกรณ์จริง (ยังไม่ได้ทำ)

- การประกอบคำของ IME ภาษาไทย: Gboard (Android WebView), แป้นพิมพ์ iOS (WKWebView) และ Windows Thai Kedmanee
- selection handles และ long-press บนจอสัมผัส
- ฟอนต์ไทยใน terminal (ความกว้างของสระบน/ล่างใน grid ของ xterm.js)

ผลของแถว CodeMirror 6 (มือถือ) อยู่ในรายงาน spike แยกต่างหาก
