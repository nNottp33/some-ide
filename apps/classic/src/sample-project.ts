import type { ProjectSnapshot } from '@some/runtime-core/core/vfs'

/** The starter project shown on first launch (and after "Reset to Sample Project"). */
export function sampleProject(): ProjectSnapshot {
  return {
    dirs: ['/src'],
    files: {
      '/README.md': `# Welcome to some-ide 👋

IDE ที่ทำงานในเบราว์เซอร์ทั้งหมด — ไม่ต้องติดตั้งอะไร ไฟล์ทั้งหมดถูกเก็บไว้ในเบราว์เซอร์นี้
(An IDE that runs entirely in your browser. Your files are stored locally in this browser.)

## ลองเลย / Try it

| Action                         | Shortcut         |
| ------------------------------ | ---------------- |
| Run the current file           | F5               |
| Stop                           | Shift+F5         |
| Go to file                     | Ctrl+P           |
| Command palette                | Ctrl+Shift+P     |
| Search in all files            | Ctrl+Shift+F     |
| Save / Save all                | Ctrl+S / Ctrl+Alt+S |
| Toggle console                 | Ctrl+J           |
| Toggle sidebar                 | Ctrl+B           |

## Files in this sample

- \`src/main.ts\` — TypeScript with imports. Open it and press **F5**.
- \`hello.py\` — Python, running in the browser via Pyodide (WebAssembly).
- \`index.html\` — a web page; running it opens a **live preview** that reloads on save.
- \`data.json\` — read by both the web page (\`fetch\`) and the Python script (\`open\`).

## Good to know

- Import other project files with relative paths: \`import { greet } from './greet'\`.
- npm packages work too — \`import confetti from 'canvas-confetti'\` is loaded from esm.sh.
- \`prompt()\` (JS) and \`input()\` (Python) read lines from the **Input** box in the Console panel.
- Unsaved changes survive a page reload. Use **Download Project as .zip** to back up your work.
`,
      '/src/main.ts': `import { greet } from './greet'
import { fibonacci, isPrime } from './math'

console.log(greet('some-ide'))

const fibs = Array.from({ length: 12 }, (_, i) => fibonacci(i))
console.log('Fibonacci:', fibs)

const primes = Array.from({ length: 50 }, (_, i) => i).filter(isPrime)
console.log(\`Found \${primes.length} primes below 50:\`, primes)

interface Task {
  title: string
  done: boolean
}

const tasks: Task[] = [
  { title: 'Open a file from the Explorer', done: true },
  { title: 'Press F5 to run it', done: true },
  { title: 'Build something cool', done: false },
]
console.table(tasks)

// Top-level await works, and the program ends when no timers are left.
await new Promise((resolve) => setTimeout(resolve, 500))
console.log('Done ✨')
`,
      '/src/math.ts': `/** Returns the n-th Fibonacci number (0, 1, 1, 2, 3, 5, …). */
export function fibonacci(n: number): number {
  let [a, b] = [0, 1]
  for (let i = 0; i < n; i++) [a, b] = [b, a + b]
  return a
}

export function isPrime(n: number): boolean {
  if (n < 2) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
`,
      '/src/greet.ts': `export function greet(name: string): string {
  const hour = new Date().getHours()
  const period = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  return \`Good \${period}, \${name}! 👋 สวัสดี!\`
}
`,
      '/index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Hello from some-ide</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <h1 id="greeting">Hello!</h1>
      <p>Edit <code>index.html</code>, <code>style.css</code> or <code>app.js</code> and save — this preview reloads.</p>
      <button id="counter">Click me</button>
      <h2>Favourite languages</h2>
      <ul id="languages"></ul>
    </main>
    <script type="module" src="app.js"></script>
  </body>
</html>
`,
      '/style.css': `:root {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: #1f2330;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #eef0ff, #ffeef8);
}

main {
  max-width: 32rem;
  padding: 2rem;
}

button {
  font: inherit;
  padding: 0.6rem 1.2rem;
  border: 0;
  border-radius: 999px;
  background: #6d7cff;
  color: white;
  cursor: pointer;
}

button:active {
  transform: scale(0.97);
}
`,
      '/app.js': `// Project files can be imported directly — even TypeScript.
import { greet } from './src/greet.ts'

document.querySelector('#greeting').textContent = greet('browser')

let count = 0
const button = document.querySelector('#counter')
button.addEventListener('click', () => {
  count++
  button.textContent = \`Clicked \${count} time\${count === 1 ? '' : 's'}\`
  console.log('count =', count)
})

// fetch() can read files from the project.
const response = await fetch('./data.json')
const data = await response.json()
document.querySelector('#languages').innerHTML = data.languages
  .map((lang) => \`<li>\${lang.name} \${'★'.repeat(lang.stars)}</li>\`)
  .join('')
`,
      '/hello.py': `import json
from datetime import date


def fizzbuzz(n: int) -> str:
    if n % 15 == 0:
        return "FizzBuzz"
    if n % 3 == 0:
        return "Fizz"
    if n % 5 == 0:
        return "Buzz"
    return str(n)


with open("data.json", encoding="utf-8") as f:
    data = json.load(f)

print(f"สวัสดีจาก Python! Today is {date.today():%d %B %Y}")
for lang in data["languages"]:
    print(f"- {lang['name']:<12} {'★' * lang['stars']}")

print(", ".join(fizzbuzz(i) for i in range(1, 16)))
`,
      '/data.json': `{
  "languages": [
    { "name": "TypeScript", "stars": 5 },
    { "name": "Python", "stars": 5 },
    { "name": "HTML & CSS", "stars": 4 }
  ]
}
`,
    },
  }
}
