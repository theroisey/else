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
    for (const width of [360, 390, 430, 640, 768, 820, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 })
      if (width < 1024) await expect(page.locator('.mobile-navigation a[aria-current="page"]')).toHaveAttribute('href', '/app/clients')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      const targets = await page.locator('.shell-header button, .shell-header summary, .shell-header a.ui-button').evaluateAll(elements => elements.filter(el => el.getClientRects().length).map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height } }))
      for (const target of targets) { expect(target.left).toBeGreaterThanOrEqual(0); expect(target.right).toBeLessThanOrEqual(width); if (width < 640) expect(target.height).toBeGreaterThanOrEqual(44) }
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
  // Exercise real CSS env() insets rather than assuming all phones have zero safe area.
  const device = await page.context().newCDPSession(page)
  await device.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 44, bottom: 34, left: 0, right: 0 } })
  await page.setViewportSize({ width: 390, height: 680 })
  expect(await page.locator('.mobile-navigation').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom))).toBeGreaterThanOrEqual(34)
  expect(await page.locator('.shell-header').evaluate(el => parseFloat(getComputedStyle(el).paddingTop))).toBeGreaterThanOrEqual(44)
  await page.locator('.mobile-navigation').getByRole('button', { name: 'More', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'More', exact: true })).toBeVisible()
  await page.getByRole('dialog', { name: 'More', exact: true }).getByRole('link', { name: 'Audit history', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: 'Close navigation', exact: true })).toBeInViewport()
  await page.screenshot({ path: info.outputPath('mobile-more-safe-area.png') })
  await page.keyboard.press('Escape')
  await device.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 21, left: 44, right: 44 } })
  await page.setViewportSize({ width: 844, height: 390 })
  const safeBounds = await page.locator('.mobile-navigation a, .mobile-navigation button, .shell-header button, .shell-header summary').evaluateAll(elements => elements.filter(el => el.getClientRects().length).map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right } }))
  for (const bounds of safeBounds) { expect(bounds.left).toBeGreaterThanOrEqual(44); expect(bounds.right).toBeLessThanOrEqual(800) }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await device.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } })
  await device.detach()
  await page.setViewportSize({ width: 1440, height: 1000 })
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
    let openLatest = () => {}
    class NativeNotification {
      static permission = 'default'
      static requestPermission() { prompts++; this.permission = 'granted'; return Promise.resolve('granted') }
      onclick: (() => void) | null = null
      constructor(title: string, options: { body: string }) { records.push({ title, body: options.body }); openLatest = () => this.onclick?.() }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: NativeNotification, configurable: true })
    Object.assign(window, { syntheticAlerts: { records, get prompts() { return prompts }, open() { openLatest() } } })
  })
  await login(page)
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { syntheticAlerts: { prompts: number } }).syntheticAlerts.prompts)).toBe(0)
  await page.getByRole('button', { name: 'Enable browser alerts' }).click()
  await expect(page.getByText('Browser alerts are enabled for this account on this browser.', { exact: true })).toBeVisible()
  const senderContext = await browser.newContext()
  const senderPage = await senderContext.newPage()
  await login(senderPage, 'refinement.sender.fixture@example.com', '/app/portfolio')
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
  const documents: string[] = []
  page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()) })
  await page.evaluate(() => (window as unknown as { syntheticAlerts: { open(): void } }).syntheticAlerts.open())
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible()
  expect(documents).toEqual([])
  await page.getByRole('navigation', { name: 'Application', exact: true }).getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Disable browser alerts' }).click()
  await page.getByText('Synthetic refinement owner', { exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await senderContext.close()
})

test('refinement: navigation is immediate, restores focus and limits fades to loading', async ({
  page,
}) => {
  await login(page)
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible()
  await page.evaluate(() => {
    const original = HTMLElement.prototype.animate
    const frames: Array<Keyframe[] | PropertyIndexedKeyframes | null> = []
    HTMLElement.prototype.animate = function (keyframes, options) {
      if (this.id === 'workspace-content') frames.push(keyframes as Keyframe[])
      return original.call(this, keyframes, options)
    }
    Object.assign(window, { syntheticTransitions: frames })
  })
  let releaseLoading: () => void = () => {}
  const loading = new Promise<void>((resolve) => { releaseLoading = resolve })
  await page.route('**/api/v1/clients?*', async (route) => {
    await loading
    await route.continue()
  })
  await page
    .getByRole('navigation', { name: 'Application', exact: true })
    .getByRole('link', { name: 'Clients', exact: true })
    .click()
  await expect(page.locator('.page-skeleton')).toBeVisible()
  expect(await page.locator('.skeleton').first().evaluate(el => getComputedStyle(el).animationName)).toBe('loading-breathe')
  releaseLoading()
  await expect(
    page.getByRole('heading', { name: 'Clients', exact: true }),
  ).toBeVisible()
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { syntheticTransitions: Keyframe[][] }
      ).syntheticTransitions.map((frames) =>
        frames.map((frame) => Number(frame.opacity)),
      ),
    ),
  ).toEqual([])
  expect(await page.locator('.workspace-main > section').evaluate(el => getComputedStyle(el).animationName)).toBe('workspace-arrive')
  expect(await page.locator('.workspace-main > section').evaluate(el => el.getAnimations().every(animation =>
    animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().every(frame => !Object.hasOwn(frame, 'opacity')),
  ))).toBe(true)
  await expect(page.locator('#workspace-content')).toBeFocused()
  await expect(page.locator('#workspace-content')).not.toHaveAttribute('inert')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page
    .getByRole('navigation', { name: 'Application', exact: true })
    .getByRole('link', { name: 'Settings', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { syntheticTransitions: unknown[] })
          .syntheticTransitions.length,
    ),
  ).toBe(0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 390, height: 844 })
  const more = page.locator('.mobile-navigation').getByRole('button', { name: 'More', exact: true })
  await more.click()
  await expect(page.getByRole('dialog', { name: 'More', exact: true })).toBeVisible()
  expect(await page.evaluate(async () => {
    for (let frame = 0; frame < 18; frame++) {
      await new Promise(requestAnimationFrame)
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth) return false
    }
    return true
  })).toBe(true)
  await page.getByRole('dialog', { name: 'More', exact: true }).getByRole('link', { name: 'Team', exact: true }).click()
  await expect(page).toHaveURL(/\/app\/team$/)
  await expect(page.getByRole('dialog', { name: 'More', exact: true })).toHaveCount(0)
  await expect(page.locator('#workspace-content')).toBeFocused()
  await expect(more).toHaveAttribute('aria-current', 'page')
  await more.click()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.getByRole('dialog', { name: 'More', exact: true })).toHaveCount(0)
  await expect(page.locator('.mobile-navigation')).toBeHidden()
  await page.goto('/app/access')
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
  await expect(page.locator('a[href="/app/access"]')).toHaveCount(0)
})

test('performance: bounded code preloading respects Save Data, cached reads are reused, searches coalesce and failed chunks recover', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true, effectiveType: '4g' } }))
  const scripts: string[] = []
  const clientReads: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('.js')) scripts.push(url.pathname)
    if (url.pathname === '/api/v1/clients') clientReads.push(url.search)
  })
  await login(page)
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Application', exact: true })
  await expect(page.locator('#workspace-content')).toBeFocused()
  await nav.getByRole('link', { name: 'Team', exact: true }).hover()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(scripts.some(path => /\/TeamPage-/.test(path))).toBe(false)
  await page.evaluate(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: false, effectiveType: '4g' } }))
  await nav.getByRole('link', { name: 'Clients', exact: true }).hover()
  await expect.poll(() => scripts.some(path => /\/ClientsPage-/.test(path))).toBe(true)
  expect(clientReads).toEqual([]) // Importing public code must never fetch private records.
  await nav.getByRole('link', { name: 'Clients', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Clients', exact: true })).toBeVisible()
  await expect(page.getByRole('table', { name: 'Clients', exact: true })).toBeVisible()
  const loaded = clientReads.length
  await nav.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await nav.getByRole('link', { name: 'Clients', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Clients', exact: true })).toBeVisible()
  expect(clientReads.length).toBe(loaded)
  await nav.getByRole('link', { name: 'Today', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
  await page.getByText('Filter by brand and team', { exact: true }).click()
  await expect(page.getByLabel('Brand', { exact: true })).toBeEnabled()
  clientReads.length = 0
  await page.getByLabel('Find brand', { exact: true }).pressSequentially('Synthetic', { delay: 15 })
  await expect(page.getByLabel('Find brand', { exact: true })).toHaveValue('Synthetic')
  await expect.poll(() => clientReads.filter(query => new URLSearchParams(query).get('q') === 'Synthetic').length).toBe(1)
  expect(clientReads.filter(query => new URLSearchParams(query).get('q'))).toHaveLength(1)
  await page.route('**/assets/UsersPage-*.js', route => route.abort())
  await nav.getByText('More', { exact: true }).click()
  await nav.getByRole('link', { name: 'Users', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Users page unavailable', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reload page', exact: true })).toBeVisible()
  await nav.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
})
