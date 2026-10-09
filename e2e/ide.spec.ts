import { expect, test, type Page } from '@playwright/test'

const consoleOutput = (page: Page) => page.locator('.console-output')

async function quickOpen(page: Page, name: string) {
  await page.keyboard.press('Control+P')
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await expect(page.locator('.tab.active')).toContainText(name)
}

async function replaceEditorText(page: Page, text: string) {
  await page.locator('.editor-host .view-lines').click()
  await page.keyboard.press('Control+A')
  // Paste rather than type, so Monaco's auto-indent and auto-closing don't change the text.
  await page.evaluate((t) => navigator.clipboard.writeText(t), text)
  await page.keyboard.press('Control+V')
}

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
})

test('shows the sample project on first launch', async ({ page }) => {
  await expect(page.locator('.tree-row')).toContainText(['src', 'greet.ts', 'main.ts', 'math.ts', 'app.js'])
  await expect(page.locator('.tab .tab-label')).toHaveText(['README.md', 'main.ts'])
  await expect(page.locator('.tab.active .tab-label')).toHaveText('main.ts')
})

test('runs TypeScript with imports and console.table', async ({ page }) => {
  await page.keyboard.press('F5')
  await expect(consoleOutput(page)).toContainText('Fibonacci: [ 0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89 ]')
  await expect(consoleOutput(page)).toContainText('│ (index) │ title')
  await expect(consoleOutput(page)).toContainText('Done ✨')
  await expect(consoleOutput(page)).toContainText('✓ Finished')
})

test('reports runtime errors with clickable locations', async ({ page }) => {
  await replaceEditorText(page, "const fail = () => {\n  throw new Error('boom')\n}\nfail()")
  await page.keyboard.press('F5')
  await expect(consoleOutput(page)).toContainText('Error: boom')
  await expect(consoleOutput(page)).toContainText('✗ Exited with errors')
  await page.locator('.console-link', { hasText: '/src/main.ts:2' }).first().click()
  await expect(page.locator('.status-item[title="Go to Line"]')).toContainText('Ln 2')
})

test('shows TypeScript problems', async ({ page }) => {
  await replaceEditorText(page, "const n: number = 'text'")
  await expect(page.locator('.status-item[title="Problems"]')).toContainText('1', { timeout: 15_000 })
  await page.locator('.status-item[title="Problems"]').click()
  await expect(page.locator('.problem')).toContainText("Type 'string' is not assignable to type 'number'")
})

test('previews HTML with project modules, fetch and console', async ({ page }) => {
  await quickOpen(page, 'index.html')
  await page.keyboard.press('F5')
  const frame = page.frameLocator('.preview-frame')
  await expect(frame.locator('#greeting')).toContainText('browser!')
  await expect(frame.locator('#languages li')).toHaveCount(3)
  await frame.locator('#counter').click()
  await expect(consoleOutput(page)).toContainText('count = 1')
})

test('creates, renames and deletes files', async ({ page }) => {
  await page.keyboard.press('Alt+N')
  await page.keyboard.type('lib/util.ts')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tab.active')).toHaveAttribute('title', '/lib/util.ts')
  await expect(page.locator('.tab.active')).not.toHaveClass(/dirty/)

  await page.locator('.tree-row[data-path="/lib/util.ts"]').click()
  await page.keyboard.press('F2')
  await page.keyboard.press('Control+A')
  await page.keyboard.type('helpers.ts')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tab.active')).toHaveAttribute('title', '/lib/helpers.ts')

  await page.locator('.tree-row[data-path="/lib"]').click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Delete' }).click()
  await page.locator('.dialog .button', { hasText: 'Delete' }).click()
  await expect(page.locator('.tree-row[data-path="/lib"]')).toHaveCount(0)
  await expect(page.locator('.tab[title="/lib/helpers.ts"]')).toHaveCount(0)
})

test('searches across files', async ({ page }) => {
  await page.keyboard.press('Control+Shift+F')
  await page.keyboard.type('fibonacci')
  await expect(page.locator('.search-summary')).toContainText('in 2 files')
  await page.locator('.search-match').first().click()
  await expect(page.locator('.tab.active')).toHaveAttribute('title', /\/src\/(main|math)\.ts/)
})

test('keeps files and unsaved edits across reloads', async ({ page }) => {
  await quickOpen(page, 'math.ts')
  await page.locator('.editor-host .view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('// unsaved')
  await expect(page.locator('.tab.active')).toHaveClass(/dirty/)
  await page.waitForTimeout(800) // debounce for persistence
  await page.reload()
  await expect(page.locator('.tab.dirty')).toHaveAttribute('title', '/src/math.ts')
  await page.keyboard.press('Control+S')
  await expect(page.locator('.tab.dirty')).toHaveCount(0)
})

test('command palette runs commands', async ({ page }) => {
  const theme = await page.evaluate(() => document.documentElement.dataset.theme)
  await page.keyboard.press('Control+Shift+P')
  await page.keyboard.type('toggle light')
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', theme!)
})
