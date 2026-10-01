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
