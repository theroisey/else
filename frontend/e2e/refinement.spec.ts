import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { database } from './database'

const actor = 'c0444444-4444-4444-8444-444444444444'
const sender = 'c0666666-6666-4666-8666-666666666666'
const client = 'c0111111-1111-4111-8111-111111111111'
test.beforeAll(() => {
  for (const [id, email, role] of [[actor, 'refinement.owner.fixture@example.com', 'c0555555-5555-4555-8555-555555555555'], [sender, 'refinement.sender.fixture@example.com', 'c0777777-7777-4777-8777-777777777777']]) {
    database(`INSERT OR IGNORE INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT '${id}','${email}','Synthetic refinement owner',password_hash,'active',utc_now(),utc_now() FROM users WHERE id='44444444-4444-4444-8444-444444444444'; INSERT OR IGNORE INTO user_roles(id,user_id,role_id,scope_kind,assigned_at) VALUES('${role}','${id}','00000000-0000-4000-8000-000000000001','global',utc_now());`)
  }
  database(`INSERT OR IGNORE INTO client_scopes VALUES('${client}'); INSERT OR IGNORE INTO clients(id,name,created_at,updated_at) VALUES('${client}','Synthetic layout brand',utc_now(),utc_now());`)
})
async function login(page: Page, email = 'refinement.owner.fixture@example.com', path = '/app/settings') {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Application', exact: true })).toBeVisible()
}

test('refinement: inset filters, keyboard section guides and reduced motion in both themes', async ({ page }, info) => {
  await login(page, undefined, `/app/clients/${client}/reminders`)
  await expect(page.getByLabel('Search reminders')).toBeVisible()
  for (const theme of ['light', 'dark']) {
    await page.getByText('Synthetic refinement owner', { exact: true }).click()
    await page.getByLabel('Appearance', { exact: true }).selectOption(theme)
    await page.getByText('Synthetic refinement owner', { exact: true }).click()
    for (const width of [360, 390, 430, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      const inset = await page.locator('.reminder-filters').evaluate(el => {
        const bounds = el.getBoundingClientRect()
        const first = el.querySelector('input')!.getBoundingClientRect()
        return { left: first.left - bounds.left, padding: parseFloat(getComputedStyle(el).paddingRight), background: getComputedStyle(el).backgroundColor }
      })
      expect(inset.left).toBeGreaterThanOrEqual(16)
      expect(inset.padding).toBeGreaterThanOrEqual(16)
      expect(inset.background).not.toBe('rgba(0, 0, 0, 0)')
      if ([390, 1440].includes(width)) await page.screenshot({ path: info.outputPath(`refinement-${theme}-${width}.png`), fullPage: true })
    }
  }
  const help = page.getByRole('button', { name: 'Help for this section' })
  await help.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'How this section works' })).toContainText('Reminders are one-time schedules')
  await page.keyboard.press('Escape')
  await expect(help).toBeFocused()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await page.locator('.workspace-main > section').evaluate(el => parseFloat(getComputedStyle(el).animationDuration))).toBeLessThanOrEqual(0.001)
  await page.getByLabel('Owner filter').selectOption('specific')
  await expect(page.getByLabel('Owner identifier')).toBeVisible()
  await page.getByLabel('Owner identifier').fill(actor)
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page.getByLabel('Owner identifier')).toHaveValue(actor)
  await page.getByLabel('Owner filter').selectOption('me')
  await expect(page.getByLabel('Owner identifier')).toHaveCount(0)
})

test('refinement: browser permission is explicit, new private updates deliver one generic alert and logout stops delivery', async ({ page, browser }, info) => {
  test.setTimeout(90000)
  await page.addInitScript(() => {
    const records: Array<{ title: string, body: string }> = []
    let prompts = 0
    class NativeNotification {
      static permission = 'default'
      static requestPermission() { prompts++; this.permission = 'granted'; return Promise.resolve('granted') }
      onclick: (() => void) | null = null
      constructor(title: string, options: { body: string }) { records.push({ title, body: options.body }) }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: NativeNotification, configurable: true })
    Object.assign(window, { syntheticAlerts: { records, get prompts() { return prompts } } })
  })
  await login(page)
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { syntheticAlerts: { prompts: number } }).syntheticAlerts.prompts)).toBe(0)
  await page.getByRole('button', { name: 'Enable browser alerts' }).click()
  await expect(page.getByText('Browser alerts are enabled for this account on this browser.', { exact: true })).toBeVisible()
  const senderContext = await browser.newContext()
  const senderPage = await senderContext.newPage()
  await login(senderPage, 'refinement.sender.fixture@example.com', '/app/access')
  const result = await senderPage.evaluate(async (brand) => {
    const csrf = document.cookie.split('; ').find(c => c.startsWith('else_csrf='))!.slice(10)
    const response = await fetch(`/api/v1/clients/${brand}/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ command_id: crypto.randomUUID(), website_id: null, brand_wide: true, title: 'Synthetic private request title', description: 'Synthetic private description never allowed on a lock screen', category: 'bug', priority: 'normal', reference_url: '', evidence_ids: [] }) })
    return response.status
  }, client)
  expect(result).toBe(201)
  await expect.poll(() => page.evaluate(() => (window as unknown as { syntheticAlerts: { records: unknown[] } }).syntheticAlerts.records.length), { timeout: 40000 }).toBe(1)
  const messages = await page.evaluate(() => (window as unknown as { syntheticAlerts: { records: Array<{ title: string, body: string }>, prompts: number } }).syntheticAlerts)
  expect(messages.records).toEqual([{ title: 'Roisey Else', body: 'You have a new update. Open the panel to review it.' }])
  expect(messages.prompts).toBe(1)
  await page.screenshot({ path: info.outputPath('browser-alert-settings.png'), fullPage: true })
  await page.getByRole('button', { name: 'Disable browser alerts' }).click()
  await page.getByText('Synthetic refinement owner', { exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await senderContext.close()
})
