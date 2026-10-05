import { test, expect } from '@playwright/test'

test('keeps translated client filters aligned, keyboard usable and bounded in both themes', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.goto('/app/clients')
  await page
    .getByLabel('Email', { exact: true })
    .fill('admin.fixture@example.com')
  await page
    .getByLabel('Password', { exact: true })
    .fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const filters = page.locator('.clients-filters')
  await expect(filters).toBeVisible()
  const search = filters.locator('input[type="search"]')
  await search.fill('Synthetic keyboard filter')
  const applied = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname === '/api/v1/clients' &&
      url.searchParams.get('q') === 'Synthetic keyboard filter'
    )
  })
  await search.press('Enter')
  expect((await applied).status()).toBe(200)
  await search.focus()
  await search.press('Tab')
  await expect(filters.locator('input[name="tag"]')).toBeFocused()

  for (const locale of ['en', 'tr', 'ro', 'de', 'fr']) {
    await page.evaluate((value) => {
      localStorage.setItem('roisey-else.locale', value)
      dispatchEvent(new StorageEvent('storage', { key: 'roisey-else.locale' }))
    }, locale)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    for (const mode of ['light', 'dark']) {
      await page.evaluate((value) => {
        localStorage.setItem('roisey-else.appearance', value)
        dispatchEvent(
          new StorageEvent('storage', { key: 'roisey-else.appearance' }),
        )
      }, mode)
      await expect(page.locator('html')).toHaveAttribute(
        'data-appearance',
        mode,
      )
      for (const width of [375, 768, 1280, 1440, 1920, 2880]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.evaluate(() => document.fonts.ready)
        const measured = await filters.evaluate((element) => {
          const controls = [
            ...element.querySelectorAll<
              HTMLInputElement | HTMLSelectElement | HTMLButtonElement
            >('input, select, button'),
          ]
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            controls: controls.map((control) => {
              const rect = control.getBoundingClientRect()
              return {
                top: rect.top,
                height: rect.height,
                left: rect.left,
                right: rect.right,
                labelled:
                  control instanceof HTMLButtonElement ||
                  Boolean(control.labels?.length),
              }
            }),
          }
        })
        expect(measured.overflow, `${locale} ${mode} ${width}`).toBe(false)
        expect(measured.controls).toHaveLength(5)
        for (const control of measured.controls) {
          expect(control.labelled).toBe(true)
          expect(control.left).toBeGreaterThanOrEqual(0)
          expect(control.right).toBeLessThanOrEqual(width)
          expect(control.height).toBe(width < 640 ? 44 : 40)
        }
        if (width >= 1280) {
          const tops = measured.controls.map((control) => control.top)
          expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1)
        }
      }
    }
  }
})
