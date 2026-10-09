import { expect, test } from '@playwright/test'

test('works on a phone-sized screen', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
  await expect(page.locator('.sidebar')).toBeHidden()

  await page.locator('.activity-item[data-view="explorer"]').tap()
  await expect(page.locator('.sidebar')).toBeVisible()
  await page.locator('.tree-row[data-path="/index.html"]').tap()
  await expect(page.locator('.sidebar')).toBeHidden()

  await page.locator('.run-button').tap()
  await expect(page.frameLocator('.preview-frame').locator('#greeting')).toContainText('browser!')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
})
