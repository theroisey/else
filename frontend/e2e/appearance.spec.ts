import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'

const officialPath = /\s+d="([^"]+)"/.exec(
  readFileSync('src/components/brand/Brand.tsx', 'utf8'),
)![1]!

for (const preference of ['light', 'dark', 'system'])
  test(`applies ${preference} appearance before the application bundle renders under CSP`, async ({
    page,
    context,
  }, info) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await context.addInitScript(
      (preference) =>
        localStorage.setItem('roisey-else.appearance', preference),
      preference,
    )
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/assets/index-*.js', async (route) => {
      await blocked
      await route.continue()
    })
    try {
      await page.goto('/login', { waitUntil: 'commit' })
      await expect
        .poll(() =>
          page.evaluate(() => ({
            dark: document.documentElement.classList.contains('dark'),
            children: document.getElementById('root')?.childElementCount ?? -1,
          })),
        )
        .toEqual({ dark: preference !== 'light', children: 1 })
      await expect(
        page.getByRole('progressbar', { name: 'Roisey Else' }),
      ).toBeVisible()
      const mark = page.locator('.boot-loading > svg')
      await expect(mark).toHaveAttribute('viewBox', '0 0 46 64')
      await expect(mark.locator('path')).toHaveAttribute('d', officialPath)
      await expect(mark.locator('rect, image')).toHaveCount(0)
      await expect(page.locator('.boot-loading img')).toHaveCount(0)
      await expect(mark.locator('path')).toHaveAttribute('fill', 'currentColor')
      const standalone = await (
        await page.request.get('/assets/roisey-logo.svg')
      ).text()
      expect(standalone).toContain(officialPath)
      expect(standalone).toContain('viewBox="0 0 46 64"')
      expect(standalone).not.toMatch(/<rect|<image|transform=/)
      for (const width of [360, 390, 430, 1280, 1920]) {
        await page.setViewportSize({ width, height: 844 })
        const shape = await mark.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          return {
            ratio: bounds.width / bounds.height,
            center: bounds.left + bounds.width / 2,
            color: getComputedStyle(element).color,
            expected: getComputedStyle(document.body).color,
            background: getComputedStyle(element).backgroundColor,
            bodyOverflow: document.documentElement.scrollWidth > innerWidth,
          }
        })
        expect(shape.ratio).toBeCloseTo(46 / 64, 3)
        expect(shape.center).toBeCloseTo(width / 2, 0)
        expect(shape.color).toBe(shape.expected)
        expect(shape.background).toBe('rgba(0, 0, 0, 0)')
        expect(shape.bodyOverflow).toBe(false)
        if (width === 390 || width === 1280)
          await page.screenshot({
            path: info.outputPath(`startup-${preference}-${width}.png`),
          })
      }
      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect(
        await page
          .locator('.boot-progress')
          .evaluate((element) =>
            parseFloat(getComputedStyle(element).animationDuration),
          ),
      ).toBeLessThanOrEqual(0.001)

      expect(
        await page.evaluate(
          () =>
            document.querySelector('script[src="/assets/theme-init.js"]') !==
            null,
        ),
      ).toBe(true)
      release()
      await expect(
        page.getByRole('heading', { name: 'Sign in', exact: true }),
      ).toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Appearance', exact: true }),
      ).toContainText(
        preference === 'dark'
          ? 'Dark'
          : preference === 'light'
            ? 'Light'
            : 'System',
      )
    } finally {
      release()
    }
  })

test('persists selection across reload and responds to device changes in System', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/login')
  const control = page.getByRole('button', { name: 'Appearance', exact: true })
  async function choose(value: string) {
    await control.click()
    await page
      .getByRole('dialog', { name: 'Appearance', exact: true })
      .getByRole('button', { name: value, exact: true })
      .click()
  }
  await expect(control).toContainText('System')
  await choose('Dark')
  await page.reload()
  await expect(control).toContainText('Dark')
  await expect(page.locator('html')).toHaveClass('dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveClass('dark')
  await choose('System')
  await expect(page.locator('html')).not.toHaveClass('dark')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass('dark')
  await choose('Light')
  await expect(page.locator('html')).not.toHaveClass('dark')
  await page.reload()
  await expect(control).toContainText('Light')
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
})

test('keeps public login usable at narrow widths in both themes', async ({
  page,
}, info) => {
  await page.goto('/login')
  await expect(page.locator('.login-header select')).toHaveCount(0)
  for (const width of [320, 360, 390, 430, 640, 768, 820, 1280, 1600, 1920]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const theme of ['light', 'dark']) {
      await page
        .getByRole('button', { name: 'Appearance', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: 'Appearance', exact: true })
        .getByRole('button', {
          name: theme === 'light' ? 'Light' : 'Dark',
          exact: true,
        })
        .click()
      await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
      await page.evaluate(async () => {
        // Inherited theme colors can retarget a child's transition after the
        // body finishes; capture a settled frame rather than a mid-fade image.
        for (let frame = 0; frame < 8; frame++) {
          await new Promise(requestAnimationFrame)
          const active = document
            .getAnimations()
            .filter(
              (a) =>
                a.playState === 'running' &&
                a.effect?.getComputedTiming().endTime !== Infinity,
            )
          if (!active.length) break
          await Promise.allSettled(active.map((a) => a.finished))
        }
      })
      if ([390, 1280].includes(width))
        await page.screenshot({
          path: info.outputPath(`login-${theme}-${width}.png`),
          fullPage: true,
        })
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true)
    }
  }
})

// Exercise actual translated preference dialogs at the smallest supported viewport.
test('public footer preferences remain keyboard accessible in every language', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/login')
  const languageLabels = ['Language', 'Dil', 'Limbă', 'Sprache', 'Langue']
  const names = ['Türkçe', 'Română', 'Deutsch', 'Français', 'English']
  for (let index = 0; index < names.length; index++) {
    const trigger = page.getByRole('button', {
      name: languageLabels[index]!,
      exact: true,
    })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: names[index]!, exact: true })
      .click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(
      page.getByRole('button', {
        name: languageLabels[(index + 1) % languageLabels.length]!,
        exact: true,
      }),
    ).toBeFocused()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await expect(page.locator('.login-footer')).toBeVisible()
  }
  const trigger = page.getByRole('button', { name: 'Appearance', exact: true })
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})
