// Sample documents. Thai text deliberately uses combining vowels/tone marks
// (U+0E31, U+0E34-0E3A, U+0E47-0E4E) so that cursor movement, selection and
// deletion over grapheme clusters can be checked.

export const tsSample = `// สวัสดี — CodeMirror 6 phone-editor spike (TypeScript sample)
// ผู้ใช้สามารถแก้ไขไฟล์นี้ได้จากโทรศัพท์ (Thai mixed with English and numbers 123)
import { readFile } from "node:fs/promises";

/** ชื่อเมือง: กรุงเทพมหานคร, เชียงใหม่, ขอนแก่น */
export interface City {
  name: string;        // ชื่อ
  population: number;  // จำนวนประชากร
  tags: string[];
}

const greeting = "สวัสดีครับ ผู้ใช้ 42 คน";
const water = "น้ำ";                // tone mark + vowel in one cluster
const aunt = "ป้า";                 // mai tho on U+0E1B
const mixed = "TypeScript กับ ภาษาไทย 2026 ✓";

export async function loadCities(path: string): Promise<City[]> {
  const raw = await readFile(path, "utf8");
  const cities: City[] = JSON.parse(raw);
  // เรียงลำดับตามจำนวนประชากร (sort by population, descending)
  cities.sort((a, b) => b.population - a.population);
  for (const c of cities) {
    if (c.name === "กรุงเทพมหานคร") c.tags.push("เมืองหลวง");
  }
  return cities;
}

export function describe(c: City): string {
  return \`\${c.name} มีประชากร \${c.population.toLocaleString("th-TH")} คน\`;
}

console.log(greeting, water, aunt, mixed);
`;

export const pySample = `# -*- coding: utf-8 -*-
"""สวัสดี — Python sample for the CM6 phone-editor spike.

ผู้ใช้สามารถแก้ไขไฟล์นี้ได้จากโทรศัพท์ (mixed Thai/English/numbers 123).
"""
from dataclasses import dataclass, field


@dataclass
class City:
    name: str                     # ชื่อเมือง เช่น กรุงเทพมหานคร
    population: int               # จำนวนประชากร
    tags: list[str] = field(default_factory=list)


greeting = "สวัสดีครับ ผู้ใช้ 42 คน"
water = "น้ำ"    # tone mark + vowel
aunt = "ป้า"


def describe(c: City) -> str:
    # คืนค่าข้อความอธิบายเมือง
    return f"{c.name} มีประชากร {c.population:,} คน"


if __name__ == "__main__":
    bkk = City("กรุงเทพมหานคร", 5_500_000, ["เมืองหลวง"])
    print(describe(bkk), greeting, water, aunt)
`;

const thaiComments = [
  "ตรวจสอบค่าก่อนบันทึก",
  "ผู้ใช้ต้องเข้าสู่ระบบก่อน",
  "น้ำหนักของข้อมูลมากเกินไป",
  "กรุงเทพมหานคร เชียงใหม่ ภูเก็ต",
  "ป้าบอกว่าให้รีบทำ",
  "สวัสดีชาวโลก 123 hello",
];

/** Generates a ~20,000 line TypeScript file with Thai comments sprinkled in. */
export function bigSample(lines = 20000): string {
  const out: string[] = [];
  out.push("// Generated performance sample — " + lines + " lines");
  out.push("export const registry = new Map<string, number>();");
  let i = 0;
  while (out.length < lines) {
    const n = i++;
    out.push("");
    out.push(`// ${thaiComments[n % thaiComments.length]} (#${n})`);
    out.push(`export function handler${n}(input: { id: number; name: string; tags: string[] }): string {`);
    out.push(`  const label = "รายการ " + input.name + " #" + input.id;`);
    out.push(`  if (input.tags.includes("urgent")) {`);
    out.push(`    registry.set(label, (registry.get(label) ?? 0) + ${n % 7});`);
    out.push(`  }`);
    out.push(`  for (let k = 0; k < input.tags.length; k++) {`);
    out.push(`    if (input.tags[k].startsWith("ป้า")) return label + " ป้า";`);
    out.push(`  }`);
    out.push(`  return label;`);
    out.push(`}`);
  }
  out.length = lines;
  return out.join("\n");
}
