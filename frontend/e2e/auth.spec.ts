import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

function database(sql: string) {
  const container = process.env.AUTH_TEST_CONTAINER
  if (!container || !/^[a-f0-9]{12,64}$/.test(container)) throw new Error('An isolated browser-test container is required.')
  return execFileSync('docker', ['--host=unix:///var/run/docker.sock', 'exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'else', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim()
}

async function signIn(page: Page) {
  await page.getByLabel('Email', { exact: true }).fill('browser.fixture@example.com')
  await page.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

async function markSyntheticScreenshot(page: Page) {
  await page.evaluate(() => {
    document.querySelector('[data-synthetic-verification]')?.remove()
    const label = document.createElement('div')
    label.dataset.syntheticVerification = 'true'
    label.textContent = 'Synthetic administration verification · isolated test data'
    const dialog = document.querySelector('dialog[open]')
    label.style.cssText = dialog
      ? 'margin-top:16px;font-size:11px;text-align:center'
      : 'position:fixed;bottom:0;left:0;right:0;z-index:100;background:#171717;color:white;padding:6px;text-align:center;font-size:11px'
    ;(dialog ?? document.body).append(label)
  })
}

test('real login, cookie security, responsive keyboard navigation and CSRF logout', async ({ page, context }, testInfo) => {
  await page.goto('/app/access')
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('login.png'), fullPage: true })
  await page.getByLabel('Email', { exact: true }).fill('browser.fixture@example.com')
  await page.getByLabel('Password', { exact: true }).fill('deliberately wrong fixture password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.')
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
  await signIn(page)
  await expect(page).toHaveURL(/\/app\/access$/)
  await expect(page.getByRole('table')).toContainText('clients.view')
  await expect(page.getByRole('table')).not.toContainText('roles.manage')
  const cookies = await context.cookies()
  const flags = cookies.map(({ name, httpOnly, sameSite, path }) => ({ name, httpOnly, sameSite, path }))
  expect(flags.find((cookie) => cookie.name === 'else_session')).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' })
  expect(flags.find((cookie) => cookie.name === 'else_csrf')).toMatchObject({ httpOnly: false, sameSite: 'Strict', path: '/' })
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, sessionReadable: document.cookie.includes('else_session=') }))).toEqual({ local: 0, session: 0, sessionReadable: false })
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 820, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`access-${viewport.width}.png`), fullPage: true })
  }
  const openNavigation = page.getByRole('button', { name: 'Open navigation' })
  await openNavigation.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('navigation', { name: 'Application', exact: true }).getByRole('link', { name: 'Workspace', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(openNavigation).toBeFocused()
  await page.getByText('Browser Fixture', { exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  expect((await context.cookies()).some((cookie) => cookie.name === 'else_session' || cookie.name === 'else_csrf')).toBe(false)
  expect(database("SELECT count(*) FROM app.audit_events WHERE event_name='session.created'")).toBe('1')
  expect(database("SELECT count(*) FROM app.audit_events WHERE event_name='session.archived'")).toBe('1')
  await page.goto('/app')
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
})

test('server-side expiry removes identity and permits safe reauthentication', async ({ page }) => {
  await page.goto('/app/access')
  await signIn(page)
  await expect(page.getByRole('table')).toBeVisible()
  database("UPDATE app.sessions SET created_at=clock_timestamp()-interval '1 minute', expires_at=clock_timestamp()-interval '1 second' WHERE revoked_at IS NULL")
  await page.getByRole('button', { name: 'Refresh access', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Your session ended')
  await expect(page.getByRole('table')).toHaveCount(0)
  await signIn(page)
  await expect(page).toHaveURL(/\/app\/access$/)
  await expect(page.getByRole('table')).toBeVisible()
  await page.getByText('Browser Fixture', { exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
})

test('revoked backend grants disappear on refresh without adding placeholder destinations', async ({ page }) => {
  await page.goto('/app/access')
  await signIn(page)
  await expect(page.getByRole('table')).toContainText('clients.view')
  database("UPDATE app.user_roles SET revoked_at=clock_timestamp() WHERE id='33333333-3333-4333-8333-333333333333'")
  await page.getByRole('button', { name: 'Refresh access', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No permissions assigned', exact: true })).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  const links = page.getByRole('navigation', { name: 'Application', exact: true }).getByRole('link')
  await expect(links).toHaveCount(3)
  await page.getByText('Browser Fixture', { exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  expect(database("SELECT count(*) FROM app.audit_events WHERE event_name='session.created'")).toBe('4')
  expect(database("SELECT count(*) FROM app.audit_events WHERE event_name='session.archived'")).toBe('3')
})

test('administration creates and updates accounts, manages scoped roles and revokes disabled sessions', async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000)
  await page.goto('/app/users')
  await page.getByLabel('Email', { exact: true }).fill('admin.fixture@example.com')
  await page.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('table', { name: 'User accounts' })).toBeVisible()
  // Public screenshots contain only deliberately synthetic identities.
  await markSyntheticScreenshot(page)
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 820, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`users-${viewport.width}.png`), fullPage: true })
    if (viewport.width === 390) {
      const region = page.getByRole('region', { name: 'User accounts', exact: true })
      await region.focus()
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  const account = page.getByRole('dialog')
  await expect(account.getByLabel('Display name', { exact: true })).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await markSyntheticScreenshot(page)
  expect(await account.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('create-account-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await account.getByLabel('Display name', { exact: true }).fill('Managed Browser Fixture')
  await account.getByLabel('Email', { exact: true }).fill('managed.fixture@example.com')
  await account.getByLabel('Initial password', { exact: true }).fill('clearly synthetic browser password')
  await account.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page.getByText('Account created. Assign roles to grant access.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit Managed Browser Fixture', exact: true }).click()
  await page.getByLabel('Display name', { exact: true }).fill('Managed Updated Fixture')
  await page.getByRole('button', { name: 'Save account', exact: true }).click()
  await expect(page.getByText('Account updated.', { exact: true })).toBeVisible()

  await page.goto('/app/roles')
  await page.getByRole('button', { name: 'Create role', exact: true }).click()
  await page.getByLabel('Role name', { exact: true }).fill('Browser Scoped Role')
  await page.getByRole('checkbox', { name: /^clients.view / }).check()
  await page.getByRole('dialog').getByRole('button', { name: 'Create role', exact: true }).click()
  await expect(page.getByText('Role created.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit permissions for Browser Scoped Role', exact: true }).click()
  await page.getByRole('checkbox', { name: /^tasks.view / }).check()
  await page.getByRole('button', { name: 'Review changes', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Replace permissions', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Role permissions updated.', { exact: true })).toBeVisible()
  await markSyntheticScreenshot(page)
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`roles-${viewport.width}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/app/users')
  await page.getByRole('button', { name: 'Roles for Managed Updated Fixture', exact: true }).click()
  await page.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('client')
  await page.getByLabel('Client ID', { exact: true }).fill('22222222-2222-4222-8222-222222222222')
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption({ label: 'Browser Scoped Role' })
  await page.getByRole('button', { name: 'Review assignment', exact: true }).click()
  await page.getByRole('button', { name: 'Assign role', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Active role assignments' })).toContainText('Browser Scoped Role')
  await page.getByRole('button', { name: 'Remove Browser Scoped Role', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Remove assignment', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Remove assignment', exact: true }).click()
  await expect(page.getByText('Role assignment removed.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  // A live session proves disablement actually revokes access, beyond table status.
  const managedContext = await browser.newContext()
  try {
    const managed = await managedContext.newPage()
    await managed.goto('http://127.0.0.1:5173/app/access')
    await managed.getByLabel('Email', { exact: true }).fill('managed.fixture@example.com')
    await managed.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
    await managed.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(managed.getByRole('heading', { name: 'No permissions assigned', exact: true })).toBeVisible()
    await managed.goto('http://127.0.0.1:5173/app/users')
    await expect(managed.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Disable Managed Updated Fixture', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await markSyntheticScreenshot(page)
    await page.screenshot({ path: testInfo.outputPath('disable-confirmation.png'), fullPage: true })
    await page.getByRole('button', { name: 'Disable account', exact: true }).click()
    await expect(page.getByText('Account disabled.', { exact: true })).toBeVisible()
    await managed.reload()
    await expect(managed.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  } finally { await managedContext.close() }

  await page.getByRole('button', { name: 'Roles for Administration Fixture', exact: true }).click()
  await page.getByRole('button', { name: 'Remove Initial Administrator', exact: true }).click()
  await page.getByRole('button', { name: 'Remove assignment', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('At least one active administrator')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Active role assignments' })).toContainText('Initial Administrator')
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0)
  expect(database("SELECT string_agg(event_name, ',' ORDER BY event_name) FROM app.audit_events WHERE resource_id=(SELECT id FROM app.users WHERE email='managed.fixture@example.com') AND event_name IN ('user.created','user.updated','user.disabled')")).toBe('user.created,user.disabled,user.updated')
  expect(database("SELECT string_agg(event_name, ',' ORDER BY event_name) FROM app.audit_events WHERE resource_id=(SELECT id FROM app.roles WHERE display_name='Browser Scoped Role') AND event_name IN ('role.created','role.permission_changed')")).toBe('role.created,role.permission_changed')
  expect(database("SELECT count(*) FROM app.audit_events WHERE event_name IN ('role_assignment.created','role_assignment.archived') AND actor_user_id='44444444-4444-4444-8444-444444444444'")).toBe('2')
})
