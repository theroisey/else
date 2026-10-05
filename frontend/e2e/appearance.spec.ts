import { test, expect } from '@playwright/test'

for (const preference of ['dark', 'system']) test(`applies ${preference} appearance before the application bundle renders under CSP`, async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await context.addInitScript(preference => localStorage.setItem('roisey-else.appearance', preference), preference)
  let release: () => void = () => {}
  const blocked = new Promise<void>(resolve => { release = resolve })
  await page.route('**/assets/index-*.js', async route => { await blocked; await route.continue() })
  try {
    await page.goto('/login', { waitUntil: 'commit' })
    await expect.poll(() => page.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), children: document.getElementById('root')?.childElementCount ?? -1 }))).toEqual({ dark: true, children: 0 })
    expect(await page.evaluate(() => document.querySelector('script[src="/assets/theme-init.js"]') !== null)).toBe(true)
    release()
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveValue(preference)
  } finally { release() }
})

test('persists selection across reload and responds to device changes in System', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/login')
  const control = page.getByRole('combobox', { name: 'Appearance' })
  await expect(control).toHaveValue('system')
  await control.selectOption('dark')
  await page.reload()
  await expect(control).toHaveValue('dark')
  await expect(page.locator('html')).toHaveClass('dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveClass('dark')
  await control.selectOption('system')
  await expect(page.locator('html')).not.toHaveClass('dark')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass('dark')
  await control.selectOption('light')
  await expect(page.locator('html')).not.toHaveClass('dark')
  await page.reload()
  await expect(control).toHaveValue('light')
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
})

test('keeps public login usable at narrow widths in both themes', async ({ page }) => {
  await page.goto('/login')
  for (const width of [320, 390, 820, 1280, 1600, 1920]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const theme of ['light', 'dark']) {
      await page.getByRole('combobox', { name: 'Appearance' }).selectOption(theme)
      await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    }
  }
})
