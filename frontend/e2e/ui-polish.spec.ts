import { test, expect } from '@playwright/test'
import { database } from './database'
import { buttonStyles } from '../src/components/ui/button-styles'

test('keeps long account titles, shared button contrast and keyboard focus usable across themes', async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const name = 'W'.repeat(100)
  database(
    `INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT 'a9977777-7777-4777-8777-777777777777','css.layout.owner.fixture@example.com','Synthetic CSS owner',password_hash,'active',utc_now(),utc_now() FROM users WHERE id='44444444-4444-4444-8444-444444444444'; INSERT INTO user_roles(id,user_id,role_id,scope_kind,assigned_at) VALUES('a9966666-6666-4666-8666-666666666666','a9977777-7777-4777-8777-777777777777','00000000-0000-4000-8000-000000000001','global',utc_now()); INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT 'a9988888-8888-4888-8888-888888888888','css.review.fixture@example.com','${name}',password_hash,'active',utc_now(),utc_now() FROM users WHERE id='44444444-4444-4444-8444-444444444444';`,
  )
  await page.goto('/app/users')
  await page
    .getByLabel('Email', { exact: true })
    .fill('css.layout.owner.fixture@example.com')
  await page
    .getByLabel('Password', { exact: true })
    .fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(
    page.getByRole('table', { name: 'User accounts', exact: true }),
  ).toBeVisible()
  const roles = page.getByRole('button', {
    name: `Roles for ${name}`,
    exact: true,
  })
  await roles.click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('heading', { name: `Roles for ${name}`, exact: true }),
  ).toBeVisible()
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('roisey-else.appearance', value)
      dispatchEvent(
        new StorageEvent('storage', { key: 'roisey-else.appearance' }),
      )
    }, theme)
    await expect(page.locator('html')).toHaveAttribute('data-appearance', theme)
    for (const width of [360, 390, 430, 820, 1280, 1920]) {
      await page.setViewportSize({ width, height: 844 })
      // Resizing resolves before every browser has painted its responsive layout.
      // Keep the same bounds, but wait for the requested viewport and reflow.
      await expect
        .poll(
          () =>
            dialog.locator('.ui-dialog-panel').evaluate((element) => {
              const title = element.firstElementChild!.querySelector('h2')!
              const range = document.createRange()
              range.selectNodeContents(title)
              const text = range.getBoundingClientRect()
              const bounds = element.getBoundingClientRect()
              return {
                viewport: innerWidth,
                pageOverflow: Math.max(
                  0,
                  document.documentElement.scrollWidth - innerWidth,
                ),
                panelContained: element.scrollWidth - element.clientWidth <= 1,
                textContained:
                  text.left >= bounds.left && text.right <= bounds.right,
              }
            }),
          { message: `${theme}/${width} responsive dialog bounds` },
        )
        .toEqual({
          viewport: width,
          pageOverflow: 0,
          panelContained: true,
          textContained: true,
        })
      if (width === 390 || width === 1280)
        await page.screenshot({
          path: info.outputPath(`long-dialog-${theme}-${width}.png`),
        })
    }
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(roles).toBeFocused()

  // Exercise the production Button variants under the actual shared table CSS.
  // This temporary component probe has no handlers, private data or API effects.
  const variants = [
    'primary',
    'secondary',
    'danger',
    'danger-ghost',
    'ghost',
    'text',
  ] as const
  await page.evaluate(
    (classes) => {
      const probe = document.createElement('div')
      probe.id = 'css-variant-probe'
      const table = document.createElement('table')
      table.className = 'ui-table'
      const row = table.insertRow()
      for (const value of classes) {
        const button = document.createElement('button')
        button.className = value.classes
        button.textContent = value.name
        row.insertCell().append(button)
      }
      probe.append(table)
      document.querySelector('main')!.append(probe)
    },
    variants.map((name) => ({
      name,
      classes: buttonStyles({ variant: name }),
    })),
  )
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('roisey-else.appearance', value)
      dispatchEvent(
        new StorageEvent('storage', { key: 'roisey-else.appearance' }),
      )
    }, theme)
    await expect(page.locator('html')).toHaveAttribute('data-appearance', theme)
    // A frame callback can precede even a reduced-motion transition's final paint.
    // Measure settled production colors rather than interpolated theme colors.
    await page.evaluate(async () => {
      await Promise.allSettled(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.playState === 'running' &&
              animation.effect?.getComputedTiming().endTime !== Infinity,
          )
          .map((animation) => animation.finished),
      )
    })
    const contrasts = await page
      .locator('#css-variant-probe button')
      .evaluateAll((buttons) => {
        const luminance = (color: string) => {
          const rgb = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((n) => {
              const channel = n / 255
              return channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4
            })
          return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!
        }
        return buttons.map((button) => {
          const ink = luminance(getComputedStyle(button).color)
          let surface: Element | null = button
          let background = ''
          while (surface) {
            background = getComputedStyle(surface).backgroundColor
            if (
              background !== 'rgba(0, 0, 0, 0)' &&
              background !== 'transparent'
            )
              break
            surface = surface.parentElement
          }
          const paper = luminance(background)
          return {
            name: button.textContent,
            ratio:
              (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05),
          }
        })
      })
    for (const row of contrasts)
      expect(row.ratio, `${theme}/${row.name}`).toBeGreaterThanOrEqual(4.5)
  }
  await page
    .locator('#css-variant-probe')
    .evaluate((element) => element.remove())
})
