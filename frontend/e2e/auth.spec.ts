import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
    label.textContent = 'Synthetic browser verification · isolated test data'
    const dialog = document.querySelector('dialog[open]')
    label.style.cssText = dialog
      ? 'margin-top:16px;font-size:11px;text-align:center'
      : 'position:fixed;bottom:0;left:0;right:0;z-index:100;background:#171717;color:white;padding:6px;text-align:center;font-size:11px'
    ;(dialog ?? document.body).append(label)
  })
}

async function markTaskScreenshot(page: Page) {
  await markSyntheticScreenshot(page)
  await page.evaluate(() => {
    const label = document.querySelector<HTMLElement>('[data-synthetic-verification]')!
    const panel = document.querySelector('dialog[open] .ui-dialog-panel')
    label.style.cssText = panel
      ? 'margin-top:16px;font-size:11px;text-align:center'
      : 'background:#171717;color:white;padding:6px;text-align:center;font-size:11px'
    if (panel) panel.append(label)
    else document.body.prepend(label)
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

test('client records use real pagination, forms, conflict recovery, scoped access and confirmed archival', async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000)
  database("INSERT INTO app.client_scopes(id) SELECT ('60000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,26) n; INSERT INTO app.clients(id,name) SELECT ('60000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid, 'Pagination Fixture '||lpad(n::text,2,'0') FROM generate_series(1,26) n")
  await page.goto('/app/clients')
  await page.getByLabel('Email', { exact: true }).fill('admin.fixture@example.com')
  await page.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const table = page.getByRole('table', { name: 'Clients', exact: true })
  await expect(table).toBeVisible()
  await expect(table.getByRole('row')).toHaveCount(26)
  await markSyntheticScreenshot(page)
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 820, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`clients-${viewport.width}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(table).toContainText('Pagination Fixture 26')
  await expect(table.getByRole('row')).toHaveCount(3)
  await page.getByRole('button', { name: 'Previous', exact: true }).click()
  await expect(table).toContainText('Synthetic Browser Client')
  await page.getByRole('link', { name: 'Create client', exact: true }).click()
  await page.getByRole('button', { name: 'Create client', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('1–200 characters')
  await page.getByLabel('Client name', { exact: true }).fill('Managed Client Fixture')
  await page.getByLabel('Legal name', { exact: true }).fill('Synthetic Client Legal Name')
  await page.getByLabel('Website', { exact: true }).fill('https://example.com')
  await page.getByLabel('Internal notes', { exact: true }).fill('Clearly synthetic client notes for browser verification.')
  await page.getByLabel('Tags', { exact: true }).fill('BROWSER\nFixture')
  await page.getByRole('button', { name: 'Add contact', exact: true }).click()
  await page.getByLabel('Contact 1 name', { exact: true }).fill('Client Contact Fixture')
  await page.getByLabel('Contact 1 email', { exact: true }).fill('client.contact@example.com')
  await page.getByLabel('Contact 1 phone', { exact: true }).fill('+1 555 0100')
  await markSyntheticScreenshot(page)
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`client-form-${viewport.width}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Create client', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Client created.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Managed Client Fixture', exact: true })).toBeVisible()
  const clientID = page.url().split('/').at(-1)!
  expect(clientID).toMatch(/^[0-9a-f-]{36}$/)
  await markSyntheticScreenshot(page)
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 820, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`client-workspace-${viewport.width}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('link', { name: 'Profile', exact: true }).click()
  await page.getByRole('link', { name: 'Edit client', exact: true }).click()
  await expect(page.getByLabel('Contact 1 name', { exact: true })).toHaveValue('Client Contact Fixture')
  // Simulate another editor using the same real endpoint and revision boundary.
  const raced = await page.evaluate(async (id) => {
    const current = (await (await fetch(`/api/v1/clients/${id}`)).json()).data
    const token = document.cookie.split('; ').find(c => c.startsWith('else_csrf='))?.slice('else_csrf='.length)
    const { name, legal_name, website, notes, contacts, tags, revision } = current
    const response = await fetch(`/api/v1/clients/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token ?? '' }, body: JSON.stringify({ name: `${name} Current`, legal_name, website, notes, contacts, tags, expected_revision: revision }) })
    return response.status
  }, clientID)
  expect(raced).toBe(200)
  await page.getByLabel('Client name', { exact: true }).fill('Draft Client Fixture')
  await page.getByRole('button', { name: 'Save client', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('record changed')
  await expect(page.getByLabel('Client name', { exact: true })).toHaveValue('Draft Client Fixture')
  await page.getByRole('button', { name: 'Reload current data', exact: true }).click()
  await expect(page.getByLabel('Client name', { exact: true })).toHaveValue('Managed Client Fixture Current')
  await page.getByLabel('Client name', { exact: true }).fill('Updated Client Fixture')
  await page.getByRole('button', { name: 'Save client', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Client updated.' })).toBeVisible()

  const viewerContext = await browser.newContext()
  try {
    const viewer = await viewerContext.newPage()
    await viewer.goto('http://127.0.0.1:5173/app/clients')
    await viewer.getByLabel('Email', { exact: true }).fill('client.viewer.fixture@example.com')
    await viewer.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
    await viewer.getByRole('button', { name: 'Sign in', exact: true }).click()
    const scopedTable = viewer.getByRole('table', { name: 'Clients', exact: true })
    await expect(scopedTable).toContainText('Synthetic Browser Client')
    await expect(scopedTable.getByRole('row')).toHaveCount(2)
    await expect(viewer.getByRole('link', { name: 'Create client', exact: true })).toHaveCount(0)
    await viewer.getByRole('link', { name: 'Open Synthetic Browser Client', exact: true }).click()
    await expect(viewer.getByRole('heading', { name: 'Synthetic Browser Client', exact: true })).toBeVisible()
    await expect(viewer.getByRole('link', { name: 'Edit client', exact: true })).toHaveCount(0)
    await expect(viewer.getByRole('button', { name: 'Archive client', exact: true })).toHaveCount(0)
    await viewer.goto(`http://127.0.0.1:5173/app/clients/${clientID}`)
    await expect(viewer.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible()
    await expect(viewer.getByText('Updated Client Fixture', { exact: true })).toHaveCount(0)
  } finally { await viewerContext.close() }

  await page.getByRole('link', { name: 'Profile', exact: true }).click()
  await page.getByRole('button', { name: 'Archive client', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  expect(database(`SELECT revision::text FROM app.clients WHERE id='${clientID}'`)).toBe('3')
  await markSyntheticScreenshot(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('archive-client-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Confirm archive', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Client archived.' })).toBeVisible()
  await expect(page.getByText('Client Contact Fixture', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Edit client', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Archive client', exact: true })).toHaveCount(0)
  await page.goto('/app/clients')
  await page.getByLabel('Search by name', { exact: true }).fill('Updated Client')
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('archived')
  await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('-id')
  await page.getByLabel('Tag', { exact: true }).fill('BROWSER')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(table).toContainText('Updated Client Fixture')
  await expect(table.getByRole('row')).toHaveCount(2)
  expect(database(`SELECT string_agg(event_name, ',' ORDER BY occurred_at) FROM app.audit_events WHERE resource_id='${clientID}' AND resource_kind='client'`)).toBe('client.created,client.updated,client.updated,client.archived')
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0)
})

test('client tasks preserve drafts, confirm transitions and archive, and isolate task-only viewers', async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000)
  const clientID = '80000000-0000-4000-8000-000000000001'
  const viewerID = '99999999-9999-4999-8999-999999999999'
  const path = `/app/clients/${clientID}/tasks`
  database(`
    INSERT INTO app.client_scopes(id) VALUES ('${clientID}');
    INSERT INTO app.clients(id,name) VALUES ('${clientID}','Task Client Fixture');
    INSERT INTO app.roles(id,role_key,display_name) VALUES ('80000000-0000-4000-8000-000000000002','task_fixture','Task-only Fixture');
    INSERT INTO app.role_permissions(id,role_id,permission_key)
      VALUES ('80000000-0000-4000-8000-000000000004','80000000-0000-4000-8000-000000000002','tasks.view');
    INSERT INTO app.user_roles(id,user_id,role_id,scope_kind,client_id)
      VALUES ('80000000-0000-4000-8000-000000000003','${viewerID}','80000000-0000-4000-8000-000000000002','client','${clientID}');
    INSERT INTO app.tasks(id,client_id,title,created_by,status,priority,due_at)
      SELECT ('81000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${clientID}',
      CASE WHEN n=1 THEN 'Overdue Task Fixture' WHEN n=2 THEN 'Due Soon Task Fixture'
      ELSE 'Task Pagination Fixture '||lpad(n::text,2,'0') END,
      '44444444-4444-4444-8444-444444444444','todo','medium',
      CASE WHEN n=1 THEN clock_timestamp()-interval '1 day' ELSE clock_timestamp()+interval '1 hour' END
      FROM generate_series(1,26) n;
  `)
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill('admin.fixture@example.com')
  await page.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const table = page.getByRole('table', { name: 'Client tasks', exact: true })
  await expect(table.getByRole('row')).toHaveCount(26)
  await expect(table).toContainText('Overdue')
  await expect(table).toContainText('Due within 24 hours')
  await page.getByLabel('Search task titles', { exact: true }).fill('Task Fixture')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(table.getByRole('row')).toHaveCount(3)
  await markTaskScreenshot(page)
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 820, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    // Rasterize the scroll region before Chromium captures the full page.
    await page.getByRole('region', { name: 'Client tasks', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`tasks-${viewport.width}.png`), fullPage: true })
    if (viewport.width === 390) {
      const region = page.getByRole('region', { name: 'Client tasks', exact: true })
      await region.focus()
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByLabel('Search task titles', { exact: true }).fill('')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(table.getByRole('row')).toHaveCount(26)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(table).toContainText('Task Pagination Fixture 26')
  await expect(table.getByRole('row')).toHaveCount(2)
  await page.getByRole('link', { name: 'Create task', exact: true }).click()
  await page.getByRole('button', { name: 'Create task', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('1–200 characters')
  await page.getByLabel('Task title', { exact: true }).fill('Managed Task Fixture')
  await page.getByLabel('Description', { exact: true }).fill('Clearly synthetic task description.\nSecond plain-text line.')
  await page.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('high')
  await page.getByLabel('Assignee', { exact: true }).selectOption(viewerID)
  await page.getByLabel('Tags', { exact: true }).fill('BROWSER\nFixture')
  await page.getByLabel('Start time', { exact: true }).fill('2026-11-01T01:30')
  await page.getByLabel('Due time', { exact: true }).fill('2026-11-02T01:30')
  await page.setViewportSize({ width: 390, height: 844 })
  await markTaskScreenshot(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('task-form-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Create task', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Task created.' })).toBeVisible()
  const taskID = page.url().split('/').at(-1)!
  expect(taskID).toMatch(/^[0-9a-f-]{36}$/)
  await page.getByRole('link', { name: 'Edit task', exact: true }).click()
  // Another editor changes metadata through the real revision-checked endpoint.
  expect(await page.evaluate(async ({ clientID, taskID }) => {
    const url = `/api/v1/clients/${clientID}/tasks/${taskID}`
    const current = (await (await fetch(url)).json()).data
    const token = document.cookie.split('; ').find(c => c.startsWith('else_csrf='))?.slice('else_csrf='.length)
    const { title, description, priority, assignee_id, start_at, due_at, tags, revision } = current
    const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token ?? '' }, body: JSON.stringify({ title: title + ' Current', description, priority, assignee_id, start_at, due_at, tags, expected_revision: revision }) })
    return response.status
  }, { clientID, taskID })).toBe(200)
  await page.getByLabel('Task title', { exact: true }).fill('Draft Task Fixture')
  await page.getByRole('button', { name: 'Save task', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('record changed')
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Draft Task Fixture')
  await page.getByRole('button', { name: 'Reload current data', exact: true }).click()
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Managed Task Fixture Current')
  await expect(page.getByLabel('Assignee', { exact: true })).toHaveValue(viewerID)
  await page.getByLabel('Task title', { exact: true }).fill('Updated Task Fixture')
  await page.getByRole('button', { name: 'Save task', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Task updated.' })).toBeVisible()
  const transition = async (status: string) => {
    await page.getByLabel('Next status for Updated Task Fixture', { exact: true }).selectOption(status)
    await page.getByRole('button', { name: 'Change status of Updated Task Fixture', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Task status updated.' })).toBeVisible()
    await expect.poll(() => database(`SELECT status FROM app.tasks WHERE id='${taskID}'`)).toBe(status)
  }
  await transition('in_progress')
  await transition('done')
  await expect(page.getByText('Completed', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Edit task', exact: true })).toHaveCount(0)
  await transition('in_progress')
  await expect(page.getByText('Completed', { exact: true })).toHaveCount(0)
  await transition('cancelled')
  await expect(page.getByRole('term').filter({ hasText: /^Cancelled$/ })).toBeVisible()
  await transition('todo')
  await expect(page.getByRole('term').filter({ hasText: /^Cancelled$/ })).toHaveCount(0)
  await markTaskScreenshot(page)
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`task-detail-${viewport.width}.png`), fullPage: true })
  }
  const viewerContext = await browser.newContext({ timezoneId: 'America/New_York' })
  try {
    const viewer = await viewerContext.newPage()
    const reads: string[] = []
    viewer.on('request', request => { if (request.url().includes('/api/v1/clients/')) reads.push(new URL(request.url()).pathname) })
    await viewer.goto(`http://127.0.0.1:5173${path}/${taskID}`)
    await viewer.getByLabel('Email', { exact: true }).fill('task.viewer.fixture@example.com')
    await viewer.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
    await viewer.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(viewer.getByRole('heading', { name: 'Updated Task Fixture', exact: true })).toBeVisible()
    await expect(viewer.getByText(/Times shown in America\/New_York/)).toBeVisible()
    await expect(viewer.getByRole('link', { name: 'Edit task', exact: true })).toHaveCount(0)
    await expect(viewer.getByRole('button', { name: 'Archive Updated Task Fixture', exact: true })).toHaveCount(0)
    expect(reads).not.toContain(`/api/v1/clients/${clientID}`)
    expect(reads.some(url => url.endsWith('/assignees'))).toBe(false)
    await viewer.goto('http://127.0.0.1:5173/app/clients/22222222-2222-4222-8222-222222222222/tasks')
    await expect(viewer.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible()
    await expect(viewer.getByText('Updated Task Fixture', { exact: true })).toHaveCount(0)
    expect(await viewer.evaluate(async () => (await fetch('/api/v1/clients/22222222-2222-4222-8222-222222222222/tasks')).status)).toBe(404)
  } finally { await viewerContext.close() }
  await page.getByRole('button', { name: 'Archive Updated Task Fixture', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  expect(database(`SELECT revision::text FROM app.tasks WHERE id='${taskID}'`)).toBe('8')
  await markTaskScreenshot(page)
  await page.screenshot({ path: testInfo.outputPath('task-archive-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Confirm archive', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Task archived.' })).toBeVisible()
  await expect(page.getByText('Clearly synthetic task description.', { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Edit task', exact: true })).toHaveCount(0)
  await page.goto(path)
  await page.getByLabel('Search task titles', { exact: true }).fill('Updated Task')
  await page.getByLabel('Tag', { exact: true }).fill('BROWSER')
  await page.getByRole('combobox', { name: 'Records', exact: true }).selectOption('true')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(table).toContainText('Updated Task Fixture')
  await expect(table.getByRole('row')).toHaveCount(2)
  expect(database(`SELECT string_agg(event_name, ',' ORDER BY occurred_at) FROM app.audit_events WHERE resource_id='${taskID}' AND resource_kind='task'`)).toBe('task.created,task.updated,task.updated,task.updated,task.completed,task.updated,task.cancelled,task.updated,task.archived')
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0)
})

test('planning keeps lifecycle explicit, preserves link history and protects task privacy', async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000)
  const clientID = '90000000-0000-4000-8000-000000000001'
  const viewerID = '90000000-0000-4000-8000-000000000003'
  const roleID = '90000000-0000-4000-8000-000000000002'
  const taskID = '91000000-0000-4000-8000-000000000001'
  const path = `/app/clients/${clientID}/plans`
  database(`
    INSERT INTO app.client_scopes(id) VALUES ('${clientID}');
    INSERT INTO app.clients(id,name) VALUES ('${clientID}','Planning Client Fixture');
    INSERT INTO app.roles(id,role_key,display_name) VALUES ('${roleID}','planning_fixture','Planning-only Fixture');
    INSERT INTO app.role_permissions(id,role_id,permission_key)
      SELECT gen_random_uuid(),'${roleID}',key FROM unnest(ARRAY['planning.view','planning.update']) key;
    INSERT INTO app.users(id,email,display_name,password_hash)
      SELECT '${viewerID}','planning.viewer.fixture@example.com','Planning-only Fixture',password_hash
      FROM app.users WHERE id='44444444-4444-4444-8444-444444444444';
    INSERT INTO app.user_roles(id,user_id,role_id,scope_kind,client_id)
      VALUES ('90000000-0000-4000-8000-000000000004','${viewerID}','${roleID}','client','${clientID}');
    INSERT INTO app.plans(id,client_id,created_by,title,status)
      SELECT ('92000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${clientID}',
      '44444444-4444-4444-8444-444444444444','Plan Pagination Fixture '||lpad(n::text,2,'0'),'draft'
      FROM generate_series(1,26) n;
    INSERT INTO app.tasks(id,client_id,created_by,title,status,priority)
      SELECT ('91000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${clientID}',
      '44444444-4444-4444-8444-444444444444','Planning Task Fixture '||lpad(n::text,2,'0'),'todo','medium'
      FROM generate_series(1,26) n;
  `)
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill('admin.fixture@example.com')
  await page.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const table = page.getByRole('table', { name: 'Client plans', exact: true })
  await expect(table.getByRole('row')).toHaveCount(26)
  await page.getByRole('navigation', { name: 'Plans pagination' }).getByRole('button', { name: 'Next', exact: true }).click()
  await expect(table).toContainText('Plan Pagination Fixture 26')
  await expect(table.getByRole('row')).toHaveCount(2)
  await page.getByLabel('Search plans', { exact: true }).fill('Fixture 0')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(table.getByRole('row')).toHaveCount(10)
  for (const viewport of [{ width: 1440, height: 1050 }, { width: 820, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await markTaskScreenshot(page)
    await page.getByRole('region', { name: 'Client plans', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`planning-${viewport.width}.png`), fullPage: true })
  }
  await page.getByRole('link', { name: 'Create plan', exact: true }).click()
  await page.getByLabel('Plan title', { exact: true }).fill('Browser Plan Fixture')
  await page.getByLabel('Description', { exact: true }).fill('Clearly synthetic planning description.')
  await page.getByLabel('Start time', { exact: true }).fill('2026-10-02T12:00')
  await page.getByLabel('Due time', { exact: true }).fill('2026-10-04T12:00')
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
  await markTaskScreenshot(page)
  await page.screenshot({ path: testInfo.outputPath('planning-form-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Create plan', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Browser Plan Fixture', exact: true })).toBeVisible()
  const planID = new URL(page.url()).pathname.split('/').at(-1)!
  await page.getByRole('link', { name: 'Edit plan', exact: true }).click()
  await page.getByLabel('Plan title', { exact: true }).fill('Preserved Plan Draft')
  database(`UPDATE app.plans SET title='Current Plan Fixture',revision=revision+1,updated_at=clock_timestamp() WHERE id='${planID}'`)
  await page.getByRole('button', { name: 'Save plan', exact: true }).click()
  await expect(page.getByText('Your draft is preserved.', { exact: false })).toBeVisible()
  await expect(page.getByLabel('Plan title', { exact: true })).toHaveValue('Preserved Plan Draft')
  await page.getByRole('button', { name: 'Reload current data', exact: true }).click()
  await expect(page.getByLabel('Plan title', { exact: true })).toHaveValue('Current Plan Fixture')
  await page.getByLabel('Plan title', { exact: true }).fill('Updated Plan Fixture')
  await page.getByRole('button', { name: 'Save plan', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Updated Plan Fixture', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Open milestones', exact: true }).click()
  await page.getByRole('link', { name: 'Create milestone', exact: true }).click()
  await page.getByLabel('Milestone title', { exact: true }).fill('Browser Milestone Fixture')
  await page.getByLabel('Due time', { exact: true }).fill('2026-10-05T12:00')
  await page.getByRole('button', { name: 'Create milestone', exact: true }).click()
  await expect(page.getByText('Milestone due time must be inside the current plan date window.', { exact: true })).toBeVisible()
  expect(database(`SELECT count(*)::text FROM app.milestones WHERE plan_id='${planID}'`)).toBe('0')
  await page.getByLabel('Due time', { exact: true }).fill('2026-10-03T12:00')
  await page.getByRole('button', { name: 'Create milestone', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Browser Milestone Fixture', exact: true })).toBeVisible()
  const milestoneID = new URL(page.url()).pathname.split('/').at(-1)!
  const milestonePath = `${path}/${planID}/milestones/${milestoneID}`
  await page.getByRole('button', { name: 'Edit task links', exact: true }).click()
  await page.getByRole('checkbox', { name: /Planning Task Fixture 01/ }).check()
  await page.getByRole('navigation', { name: 'Task candidates pagination' }).getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: /Planning Task Fixture 26/ })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Task references', exact: true })).toContainText(taskID)
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
  await markTaskScreenshot(page)
  await page.screenshot({ path: testInfo.outputPath('planning-picker-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Save task links', exact: true }).click()
  await expect(page.getByText('Task links saved.', { exact: true })).toBeVisible()
  const archivedTask = '91000000-0000-4000-8000-000000000002'
  await page.getByRole('button', { name: 'Edit task links', exact: true }).click()
  await page.getByRole('checkbox', { name: /Planning Task Fixture 02/ }).check()
  database(`UPDATE app.tasks SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id='${archivedTask}'`)
  await page.getByRole('button', { name: 'Save task links', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'New links require task access' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Task references', exact: true })).toContainText(archivedTask)
  await page.getByRole('button', { name: `Remove task reference ${archivedTask}`, exact: true }).click()
  await page.getByRole('button', { name: 'Save task links', exact: true }).click()
  await expect(page.getByText('Task links saved.', { exact: true })).toBeVisible()
  const viewerContext = await browser.newContext({ timezoneId: 'America/New_York' })
  try {
    const viewer = await viewerContext.newPage()
    const reads: string[] = []
    viewer.on('request', request => { if (request.url().includes('/api/v1/clients/')) reads.push(new URL(request.url()).pathname) })
    await viewer.goto(`http://127.0.0.1:5173${milestonePath}`)
    await viewer.getByLabel('Email', { exact: true }).fill('planning.viewer.fixture@example.com')
    await viewer.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
    await viewer.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(viewer.getByRole('heading', { name: 'Browser Milestone Fixture', exact: true })).toBeVisible()
    await viewer.getByRole('button', { name: 'Edit task links', exact: true }).click()
    await expect(viewer.getByText('Task access is unavailable.', { exact: false })).toBeVisible()
    await expect(viewer.getByRole('list', { name: 'Task references', exact: true })).toContainText(taskID)
    await expect(viewer.getByText('Planning Task Fixture 01', { exact: true })).toHaveCount(0)
    expect(reads).not.toContain(`/api/v1/clients/${clientID}`)
    expect(reads.some(url => url.includes('/task-candidates') || url.includes('/tasks/'))).toBe(false)
    await viewer.getByRole('button', { name: 'Save task links', exact: true }).click()
    await expect(viewer.getByText('Task links saved.', { exact: true })).toBeVisible()
    await viewer.getByRole('button', { name: 'Edit task links', exact: true }).click()
    await viewer.getByRole('button', { name: `Remove task reference ${taskID}`, exact: true }).click()
    await viewer.getByRole('button', { name: 'Save task links', exact: true }).click()
    await expect(viewer.getByText('Task links saved.', { exact: true })).toBeVisible()
    await viewer.goto('http://127.0.0.1:5173/app/clients/22222222-2222-4222-8222-222222222222/plans')
    await expect(viewer.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible()
  } finally { await viewerContext.close() }
  await page.getByRole('button', { name: 'Refresh milestone', exact: true }).click()
  await page.getByRole('button', { name: 'Edit task links', exact: true }).click()
  await page.getByRole('checkbox', { name: /Planning Task Fixture 01/ }).check()
  await page.getByRole('button', { name: 'Save task links', exact: true }).click()
  await expect(page.getByText('Task links saved.', { exact: true })).toBeVisible()
  expect(database(`SELECT count(*)::text FROM app.milestone_task_links WHERE milestone_id='${milestoneID}'`)).toBe('2')
  expect(database(`SELECT count(*)::text FROM app.milestone_task_links WHERE milestone_id='${milestoneID}' AND unlinked_at IS NOT NULL`)).toBe('1')
  await page.getByRole('combobox', { name: 'Reference history', exact: true }).selectOption('true')
  await expect(page.getByRole('table', { name: 'Milestone task link history', exact: true }).getByRole('row')).toHaveCount(2)
  for (const viewport of [{ width: 1440, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await markTaskScreenshot(page)
    await page.screenshot({ path: testInfo.outputPath(`milestone-links-${viewport.width}.png`), fullPage: true })
  }
  await page.getByLabel('Next status for Browser Milestone Fixture', { exact: true }).selectOption('completed')
  await page.getByRole('button', { name: 'Change status of Browser Milestone Fixture', exact: true }).click()
  await expect(page.getByRole('term').filter({ hasText: /^Completed$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit task links', exact: true })).toHaveCount(0)
  await page.getByLabel('Next status for Browser Milestone Fixture', { exact: true }).selectOption('in_progress')
  await page.getByRole('button', { name: 'Change status of Browser Milestone Fixture', exact: true }).click()
  await expect(page.getByRole('term').filter({ hasText: /^Completed$/ })).toHaveCount(0)
  await page.goto(`${path}/${planID}`)
  await page.getByLabel('Next status for Updated Plan Fixture', { exact: true }).selectOption('active')
  await page.getByRole('button', { name: 'Change status of Updated Plan Fixture', exact: true }).click()
  await page.getByLabel('Next status for Updated Plan Fixture', { exact: true }).selectOption('completed')
  await page.getByRole('button', { name: 'Change status of Updated Plan Fixture', exact: true }).click()
  await expect(page.getByRole('term').filter({ hasText: /^Completed$/ })).toBeVisible()
  expect(database(`SELECT status FROM app.milestones WHERE id='${milestoneID}'`)).toBe('in_progress')
  expect(database(`SELECT status FROM app.tasks WHERE id='${taskID}'`)).toBe('todo')
  await page.goto(milestonePath)
  await expect(page.getByText('The parent plan is completed.', { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Edit milestone', exact: true })).toHaveCount(0)
  await page.goto(`${path}/${planID}`)
  await page.getByRole('button', { name: 'Archive Updated Plan Fixture', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  expect(database(`SELECT CASE WHEN archived_at IS NULL THEN 'yes' ELSE 'no' END FROM app.plans WHERE id='${planID}'`)).toBe('yes')
  await markTaskScreenshot(page)
  await page.screenshot({ path: testInfo.outputPath('planning-archive-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Confirm archive', exact: true }).click()
  await expect(page.getByText('Record archived.', { exact: true })).toBeVisible()
  expect(database(`SELECT string_agg(event_name,',' ORDER BY occurred_at) FROM app.audit_events WHERE resource_id='${planID}'`)).toBe('plan.created,plan.updated,plan.updated,plan.updated,plan.archived')
  expect(database(`SELECT count(*)::text FROM app.audit_events WHERE resource_id='${milestoneID}' AND event_name='milestone.updated'`)).toBe('7')
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0)
})

test('reminders preserve explicit timezone intent, historical references and immutable terminal views', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const clientID = 'd5555555-5555-4555-8555-555555555555',
    actorID = 'd1111111-1111-4111-8111-111111111111',
    roleID = 'd2222222-2222-4222-8222-222222222222',
    taskID = 'd3333333-3333-4333-8333-333333333333',
    ownerID = 'd4444444-4444-4444-8444-444444444444',
    path = `/app/clients/${clientID}/reminders`
  database(`
    INSERT INTO app.client_scopes(id) VALUES ('${clientID}');
    INSERT INTO app.clients(id,name) VALUES ('${clientID}','Synthetic Reminder Client');
    INSERT INTO app.users(id,email,display_name,password_hash)
      SELECT '${actorID}','reminder.fixture@example.com','Reminder Editor Fixture',password_hash FROM app.users WHERE id='44444444-4444-4444-8444-444444444444';
    INSERT INTO app.users(id,email,display_name,password_hash)
      SELECT '${ownerID}','reminder.owner.fixture@example.com','Reminder Owner Fixture',password_hash FROM app.users WHERE id='44444444-4444-4444-8444-444444444444';
    INSERT INTO app.roles(id,role_key,display_name) VALUES('${roleID}','reminder_fixture','Synthetic reminder editor');
    INSERT INTO app.role_permissions(id,role_id,permission_key)
      SELECT gen_random_uuid(),'${roleID}',permission_key FROM app.permissions WHERE permission_key IN ('reminders.view','reminders.create','reminders.update','tasks.view','planning.view');
    INSERT INTO app.user_roles(id,user_id,role_id,scope_kind,client_id) VALUES
      (gen_random_uuid(),'${actorID}','${roleID}','client','${clientID}'),(gen_random_uuid(),'${ownerID}','${roleID}','client','${clientID}');
    INSERT INTO app.tasks(id,client_id,created_by,title,status,priority) VALUES('${taskID}','${clientID}','${actorID}','Synthetic reminder linked task','todo','medium');
  `)
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill('reminder.fixture@example.com')
  await page.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No reminders on this page', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Create reminder', exact: true }).click()
  await page.getByLabel('Reminder title', { exact: true }).fill('Synthetic overlap review')
  await page.getByLabel('Description', { exact: true }).fill('Synthetic one-time reminder with a deliberate repeated-hour choice.')
  await page.getByLabel('Scheduled date', { exact: true }).fill('2026-11-01')
  await page.getByLabel('Local time', { exact: true }).fill('01:30:00.123456')
  await page.getByLabel('Timezone', { exact: true }).fill('America/New_York')
  await page.getByRole('button', { name: 'Create reminder', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Choose the intended occurrence')
  expect(database('SELECT count(*)::text FROM app.reminders')).toBe('0')
  await page.getByRole('radio', { name: /Later occurrence/ }).check()
  await expect(page.getByRole('option', { name: 'Reminder Owner Fixture', exact: true })).toBeAttached()
  await page.getByLabel('Owner', { exact: true }).selectOption(ownerID)
  await page.getByRole('listitem').filter({ hasText: 'Synthetic reminder linked task' }).getByRole('button', { name: 'Select reference', exact: true }).click()
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 820, height: 1100 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await markTaskScreenshot(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`reminder-form-${viewport.width}.png`), fullPage: true })
  }
  await page.getByRole('button', { name: 'Create reminder', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic overlap review', exact: true })).toBeVisible()
  const recordID = page.url().split('/').at(-1)!
  expect(database(`SELECT to_char(scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM app.reminders WHERE id='${recordID}'`)).toBe('2026-11-01T06:30:00.123456Z')
  expect(database(`SELECT owner_id::text FROM app.reminders WHERE id='${recordID}'`)).toBe(ownerID)
  database(`UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id='${ownerID}'`)
  await page.getByRole('link', { name: 'Edit reminder', exact: true }).click()
  await expect(page.getByLabel('Owner', { exact: true })).toHaveValue(ownerID)
  await expect(page.getByLabel('Local time', { exact: true })).toHaveValue('01:30:00.123456')
  await page.getByLabel('Reminder title', { exact: true }).fill('Unsaved synthetic draft')
  database(`UPDATE app.reminders SET title='Concurrent synthetic reminder',revision=revision+1,updated_at=clock_timestamp() WHERE id='${recordID}'`)
  await page.getByRole('button', { name: 'Save reminder', exact: true }).click()
  await expect(page.getByText('Your draft is preserved.', { exact: false })).toBeVisible()
  await expect(page.getByLabel('Reminder title', { exact: true })).toHaveValue('Unsaved synthetic draft')
  await expect(page.getByRole('button', { name: 'Save reminder', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Reload current data', exact: true }).click()
  await expect(page.getByLabel('Reminder title', { exact: true })).toHaveValue('Concurrent synthetic reminder')
  await page.getByLabel('Scheduled date', { exact: true }).fill('2026-03-08')
  await page.getByLabel('Local time', { exact: true }).fill('02:30:00')
  await expect(page.getByText('This local time does not exist', { exact: false })).toBeVisible()
  await markTaskScreenshot(page)
  await page.screenshot({ path: testInfo.outputPath('reminder-gap-mobile.png'), fullPage: true })
  expect(database(`SELECT revision::text FROM app.reminders WHERE id='${recordID}'`)).toBe('2')
  await page.getByLabel('Scheduled date', { exact: true }).fill('2026-11-01')
  await page.getByLabel('Local time', { exact: true }).fill('01:30:00.123456')
  await page.getByRole('radio', { name: /Earlier occurrence/ }).check()
  await page.getByLabel('Reminder title', { exact: true }).fill('Synthetic overlap updated')
  await page.getByRole('button', { name: 'Save reminder', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic overlap updated', exact: true })).toBeVisible()
  expect(database(`SELECT to_char(scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM app.reminders WHERE id='${recordID}'`)).toBe('2026-11-01T05:30:00.123456Z')
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${roleID}' AND permission_key IN ('tasks.view','planning.view'); UPDATE app.tasks SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id='${taskID}'`)
  await page.goto('/app/access')
  await page.getByRole('button', { name: 'Refresh access', exact: true }).click()
  await expect(page.getByRole('table')).not.toContainText('tasks.view')
  const privateReads: string[] = []
  page.on('request', request => { const url=new URL(request.url()).pathname; if (url.endsWith('/tasks') || url.includes('/plans')) privateReads.push(url) })
  await page.goto(`${path}/${recordID}/edit`)
  await expect(page.getByLabel('Reminder title', { exact: true })).toHaveValue('Synthetic overlap updated')
  await expect(page.getByText(`task · ${taskID}`, { exact: true })).toBeVisible()
  await expect(page.getByText('Synthetic reminder linked task', { exact: true })).toHaveCount(0)
  await page.getByLabel('Reminder title', { exact: true }).fill('Synthetic retained reference')
  await page.getByRole('button', { name: 'Save reminder', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic retained reference', exact: true })).toBeVisible()
  expect(privateReads).toEqual([])
  expect(database(`SELECT task_id::text FROM app.reminders WHERE id='${recordID}'`)).toBe(taskID)
  await page.getByRole('button', { name: 'Complete', exact: true }).click()
  await expect(page.getByRole('term').filter({ hasText: /^Completed$/ })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Edit reminder', exact: true })).toHaveCount(0)
  await page.goto(path+'/new')
  await page.getByLabel('Reminder title', { exact: true }).fill('Synthetic due review')
  await page.getByLabel('Scheduled date', { exact: true }).fill('2000-01-01')
  await page.getByLabel('Local time', { exact: true }).fill('09:00:00')
  await page.getByLabel('Timezone', { exact: true }).fill('UTC')
  await page.getByRole('button', { name: 'Create reminder', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic due review', exact: true })).toBeVisible()
  const dueID = page.url().split('/').at(-1)!
  await page.goto(path)
  await page.getByRole('combobox', { name: 'Schedule view', exact: true }).selectOption('due')
  await page.getByLabel('Owner filter', { exact: true }).fill('me')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Client reminders', exact: true })).toContainText('Synthetic due review')
  await expect(page.getByRole('table', { name: 'Client reminders', exact: true })).not.toContainText('Synthetic retained reference')
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 820, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await markTaskScreenshot(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`reminders-${viewport.width}.png`), fullPage: true })
  }
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await markTaskScreenshot(page)
  await page.screenshot({ path: testInfo.outputPath('reminder-dismiss-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Confirm dismissal', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No reminders on this page', exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Schedule view', exact: true }).selectOption('all')
  await page.getByRole('combobox', { name: 'State', exact: true }).selectOption('dismissed')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Client reminders', exact: true })).toContainText('Synthetic due review')
  await page.getByRole('link', { name: 'Open Synthetic due review', exact: true }).click()
  await expect(page.getByRole('term').filter({ hasText: /^Dismissed$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Complete', exact: true })).toHaveCount(0)
  await page.goto(path)
  await page.getByRole('combobox', { name: 'State', exact: true }).selectOption('completed')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Client reminders', exact: true })).toContainText('Synthetic retained reference')
  expect(database(`SELECT string_agg(event_name,',' ORDER BY occurred_at,id) FROM app.audit_events WHERE resource_id='${recordID}'`)).toBe('reminder.created,reminder.updated,reminder.updated,reminder.completed')
  expect(database(`SELECT string_agg(event_name,',' ORDER BY occurred_at,id) FROM app.audit_events WHERE resource_id='${dueID}'`)).toBe('reminder.created,reminder.dismissed')
  expect(database(`SELECT status FROM app.tasks WHERE id='${taskID}'`)).toBe('todo')
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0)
})

test('activity reads confirmed business events, paginates, refreshes and obeys current access', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const clientID = 'e5555555-5555-4555-8555-555555555555',
    actorID = 'e1111111-1111-4111-8111-111111111111',
    roleID = 'e2222222-2222-4222-8222-222222222222',
    path = `/app/clients/${clientID}/activity`
  database(`
    INSERT INTO app.client_scopes(id) VALUES ('${clientID}');
    INSERT INTO app.clients(id,name) VALUES ('${clientID}','Synthetic Activity Client');
    INSERT INTO app.users(id,email,display_name,password_hash)
      SELECT '${actorID}','activity.fixture@example.com','Activity Reader Fixture',password_hash FROM app.users WHERE id='44444444-4444-4444-8444-444444444444';
    INSERT INTO app.roles(id,role_key,display_name) VALUES('${roleID}','activity_fixture','Synthetic activity reader');
    INSERT INTO app.role_permissions(id,role_id,permission_key)
      SELECT gen_random_uuid(),'${roleID}',permission_key FROM app.permissions WHERE permission_key IN ('clients.view','clients.update','clients.archive','activity.view','tasks.view','tasks.create');
    INSERT INTO app.user_roles(id,user_id,role_id,scope_kind,client_id) VALUES(gen_random_uuid(),'${actorID}','${roleID}','client','${clientID}');
  `)
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill('activity.fixture@example.com')
  await page.getByLabel('Password', { exact: true }).fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No activity on this page', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await markTaskScreenshot(page)
  await page.screenshot({ path: testInfo.outputPath('activity-empty.png'), fullPage: true })

  // Create committed events through authenticated business APIs. Never seed,
  // rewrite or delete audit history to prepare this activity consumer test.
  const written = await page.evaluate(async clientID => {
    const token = document.cookie.split('; ').find(c => c.startsWith('else_csrf='))?.slice('else_csrf='.length) ?? ''
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': token }
    const statuses: number[] = []
    for (let revision = 1; revision <= 26; revision++) {
      const response = await fetch(`/api/v1/clients/${clientID}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ name: `Synthetic private profile ${revision}`, notes: 'Synthetic private contact note', expected_revision: revision }),
      })
      statuses.push(response.status)
      if (!response.ok) return statuses
    }
    const response = await fetch(`/api/v1/clients/${clientID}/tasks`, {
      method: 'POST', headers,
      body: JSON.stringify({ title: 'Synthetic private task title', description: 'Synthetic private task description', priority: 'medium', assignee_id: null, start_at: null, due_at: null, tags: [] }),
    })
    statuses.push(response.status)
    return statuses
  }, clientID)
  expect(written).toEqual([...Array(26).fill(200), 201])
  expect(database(`SELECT count(*)::text FROM app.audit_events WHERE client_id='${clientID}'`)).toBe('27')
  const reads: string[] = []
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/v1/')) reads.push(new URL(request.url()).pathname)
  })
  const feed = page.getByRole('list', { name: 'Client activity', exact: true })
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click()
  await expect(feed.getByRole('listitem')).toHaveCount(25)
  await expect(feed.getByRole('listitem').first()).toContainText('Task created.')
  await expect(page.locator('time').first()).toHaveText(/T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
  await expect(page.locator('body')).not.toContainText('Synthetic private')
  await expect(page.getByRole('link', { name: 'Tasks', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Planning', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Create|Edit|Archive|Complete/ })).toHaveCount(0)
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 820, height: 1100 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await markTaskScreenshot(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`activity-${viewport.width}.png`), fullPage: true })
  }
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(feed.getByRole('listitem')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Previous', exact: true }).click()
  await expect(feed.getByRole('listitem')).toHaveCount(25)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(feed.getByRole('listitem')).toHaveCount(2)

  expect(await page.evaluate(async clientID => {
    const token = document.cookie.split('; ').find(c => c.startsWith('else_csrf='))?.slice('else_csrf='.length) ?? ''
    const response = await fetch(`/api/v1/clients/${clientID}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify({ expected_revision: 27, confirm: true }) })
    return response.status
  }, clientID)).toBe(200)
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click()
  await expect(feed.getByRole('listitem').first()).toContainText('Client archived.')
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled()
  const count = database(`SELECT count(*)::text FROM app.audit_events WHERE client_id='${clientID}'`)
  expect(count).toBe('28')

  await page.route(`**/api/v1/clients/${clientID}/activity?*`, async handler => {
    const response = await handler.fetch()
    const body = await response.json()
    body.data[0].actor_name = 'Synthetic private leaked actor'
    await handler.fulfill({ response, json: body })
  })
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Unable to complete')
  await expect(feed).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('Synthetic private leaked actor')
  await markTaskScreenshot(page)
  await page.screenshot({ path: testInfo.outputPath('activity-error.png'), fullPage: true })
  await page.unroute(`**/api/v1/clients/${clientID}/activity?*`)
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(feed.getByRole('listitem').first()).toContainText('Client archived.')
  expect(reads.every(url => url === `/api/v1/clients/${clientID}/activity` || url === '/api/v1/auth/session')).toBe(true)

  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${roleID}' AND permission_key IN ('tasks.view','tasks.create','clients.update','clients.archive')`)
  await page.goto('/app/access')
  await page.getByRole('button', { name: 'Refresh access', exact: true }).click()
  await expect(page.getByRole('cell', { name: 'tasks.view', exact: true })).toHaveCount(0)
  await page.goto(path)
  await expect(feed.getByRole('listitem').first()).toContainText('Client archived.')
  await expect(feed).not.toContainText('Task created.')
  await expect(page.getByRole('link', { name: 'Tasks', exact: true })).toHaveCount(0)
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${roleID}' AND permission_key='activity.view'`)
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible()
  await expect(feed).toHaveCount(0)
  expect(database(`SELECT count(*)::text FROM app.audit_events WHERE client_id='${clientID}'`)).toBe(count)
})

test('audit viewer filters real immutable events, inspects safe differences and obeys revoked access', async ({ page }, testInfo) => {
  test.setTimeout(90000)
  const clientID = '71000000-0000-4000-8000-000000000001', actorID = '71000000-0000-4000-8000-000000000002',
    rootRole = '71000000-0000-4000-8000-000000000003', clientRole = '71000000-0000-4000-8000-000000000004'
  database(`
    INSERT INTO app.client_scopes(id) VALUES('${clientID}');
    INSERT INTO app.clients(id,name) VALUES('${clientID}','Synthetic Audit Client');
    INSERT INTO app.users(id,email,display_name,password_hash)
      SELECT '${actorID}','audit.fixture@example.com','Synthetic Audit Reader',password_hash FROM app.users WHERE id='44444444-4444-4444-8444-444444444444';
    INSERT INTO app.roles(id,role_key,display_name) VALUES('${rootRole}','audit_reader_fixture','Synthetic audit root'),('${clientRole}','audit_client_fixture','Synthetic audit client');
    INSERT INTO app.role_permissions(id,role_id,permission_key) VALUES(gen_random_uuid(),'${rootRole}','audit.view');
    INSERT INTO app.role_permissions(id,role_id,permission_key)
      SELECT gen_random_uuid(),'${clientRole}',permission_key FROM app.permissions WHERE permission_key IN ('clients.view','tasks.create','tasks.update');
    INSERT INTO app.user_roles(id,user_id,role_id,scope_kind,client_id)
      VALUES(gen_random_uuid(),'${actorID}','${rootRole}','global',NULL),(gen_random_uuid(),'${actorID}','${clientRole}','client','${clientID}');
  `)
  await page.goto('/app/audit')
  await page.getByLabel('Email', {exact:true}).fill('audit.fixture@example.com')
  await page.getByLabel('Password', {exact:true}).fill('clearly synthetic browser password')
  await page.getByRole('button', {name:'Sign in',exact:true}).click()
  await expect(page.getByRole('heading', {name:'Audit history',exact:true})).toBeVisible()
  await page.getByLabel('Event type',{exact:true}).fill('task.created')
  await page.getByRole('button',{name:'Apply filters',exact:true}).click()
  await expect(page.getByRole('heading',{name:'No audit events on this page',exact:true})).toBeVisible()
  await markTaskScreenshot(page)
  await page.screenshot({path:testInfo.outputPath('audit-empty.png'),fullPage:true})
  // Persist real audited business operations; no seeded or rewritten audit rows.
  const written = await page.evaluate(async clientID => {
    const csrf = document.cookie.split('; ').find(c=>c.startsWith('else_csrf='))?.slice('else_csrf='.length) ?? ''
    const headers = {'Content-Type':'application/json','X-CSRF-Token':csrf}
    let taskID = ''
    const body = {title:'Synthetic private audit task title',description:'Synthetic private audit task description',priority:'medium',assignee_id:null,start_at:null,due_at:null,tags:[]}
    for (let i=0;i<26;i++) {
      const response=await fetch(`/api/v1/clients/${clientID}/tasks`,{method:'POST',headers,body:JSON.stringify(body)})
      if (response.status !== 201) throw new Error('Synthetic audited write failed')
      taskID=(await response.json()).data.id
    }
    const response=await fetch(`/api/v1/clients/${clientID}/tasks/${taskID}`,{method:'PUT',headers,body:JSON.stringify({...body,title:'Synthetic private updated task title',expected_revision:1})})
    if (response.status !== 200) throw new Error('Synthetic audited update failed')
    return {taskID,requestID:response.headers.get('X-Request-ID')!}
  },clientID)
  const historyHash=()=>database("SELECT md5(string_agg(row_to_json(e)::text,'' ORDER BY id)) FROM app.audit_events e")
  const before=historyHash()
  const reads:string[]=[]
  page.on('request',request=>{if(request.method()==='GET' && new URL(request.url()).pathname.startsWith('/api/v1/')) reads.push(new URL(request.url()).pathname)})
  await page.getByRole('button',{name:'Refresh audit history',exact:true}).click()
  const table=page.getByRole('table',{name:'Audit events',exact:true})
  await expect(table.getByRole('row')).toHaveCount(26)
  for (const viewport of [{width:1440,height:1000},{width:768,height:1024},{width:390,height:844}]) {
    await page.setViewportSize(viewport)
    await markTaskScreenshot(page)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth===document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({path:testInfo.outputPath(`audit-${viewport.width}.png`),fullPage:true})
  }
  await page.getByRole('button',{name:'Next',exact:true}).click()
  await expect(table.getByRole('row')).toHaveCount(2)
  await page.getByRole('button',{name:'Previous',exact:true}).click()
  await expect(table.getByRole('row')).toHaveCount(26)
  for (const [label,value] of Object.entries({'Actor ID':actorID,'Event type':'task.updated','Client ID':clientID,'Resource kind':'task','Resource ID':written.taskID,'Request ID':written.requestID,'From (UTC, inclusive)':'0001-01-01T00:00:00Z','To (UTC, exclusive)':'9999-12-31T23:59:59.999999Z'})) await page.getByLabel(label,{exact:true}).fill(value)
  await page.getByRole('combobox',{name:'Actor kind',exact:true}).selectOption('user')
  await page.getByRole('button',{name:'Apply filters',exact:true}).click()
  await expect(table.getByRole('row')).toHaveCount(2)
  const trigger=table.getByRole('button',{name:/Inspect task.updated event/})
  await trigger.focus();await page.keyboard.press('Enter')
  const dialog=page.getByRole('dialog',{name:'Audit event details',exact:true})
  await expect(dialog.getByRole('table',{name:'Safe field differences',exact:true})).toBeVisible()
  await expect(dialog.getByRole('row',{name:'Revision 1 2',exact:true})).toBeVisible()
  await expect(dialog.getByRole('button',{name:'Close details',exact:true})).toBeFocused()
  await page.keyboard.press('Shift+Tab');await expect(dialog.getByText('Raw safe snapshots and metadata',{exact:true})).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog.locator('pre')).toBeVisible()
  await page.keyboard.press('Tab');await expect(dialog.getByRole('button',{name:'Close details',exact:true})).toBeFocused()
  await expect(dialog.locator('pre')).toContainText('"source": "http"')
  expect(await dialog.innerText()).not.toMatch(/Synthetic private|password|token|email/)
  await dialog.getByText('Raw safe snapshots and metadata',{exact:true}).click()
  await page.setViewportSize({width:1440,height:1000})
  await markTaskScreenshot(page)
  await page.evaluate(()=>{
    const panel=document.querySelector('dialog[open] .ui-dialog-panel')!
    panel.prepend(document.querySelector('[data-synthetic-verification]')!)
    panel.scrollTop=0
  })
  await page.screenshot({path:testInfo.outputPath('audit-detail-desktop.png')})
  await page.setViewportSize({width:390,height:844})
  await page.screenshot({path:testInfo.outputPath('audit-detail-mobile.png')})
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(trigger).toBeFocused()
  // Exact UTC microseconds survive filter entry and equality at the inclusive boundary.
  const occurred=await table.locator('time').getAttribute('datetime')
  await page.getByLabel('From (UTC, inclusive)',{exact:true}).fill(occurred!)
  await page.getByRole('button',{name:'Apply filters',exact:true}).click();await expect(table.getByRole('row')).toHaveCount(2)
  await page.getByLabel('To (UTC, exclusive)',{exact:true}).fill(occurred!)
  await page.getByRole('button',{name:'Apply filters',exact:true}).click();await expect(page.getByRole('alert')).toContainText('From must be earlier than To')
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();await expect(table).toBeVisible()
  expect(await table.innerText()).not.toMatch(/Synthetic private|password|token|email/)
  expect(reads.every(url=>url.startsWith('/api/v1/audit-logs') || url === '/api/v1/auth/session')).toBe(true)
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${clientRole}' AND permission_key IN ('tasks.create','tasks.update')`)
  await page.goto(`/app/clients/${clientID}/audit`)
  await expect(page.getByRole('heading',{name:'Audit history',exact:true})).toBeVisible()
  await expect(table).toBeVisible();expect(await table.innerText()).not.toContain('Synthetic private')
  await page.route(`**/api/v1/clients/${clientID}/audit-logs?*`,async handler=>{
    await handler.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'internal_error',message:'Synthetic private driver cause'}})})
  })
  await page.getByRole('button',{name:'Refresh audit history',exact:true}).click()
  await expect(page.getByRole('alert')).toBeVisible();await expect(table).toHaveCount(0)
  expect(await page.locator('body').innerText()).not.toContain('Synthetic private driver cause')
  await markTaskScreenshot(page);await page.screenshot({path:testInfo.outputPath('audit-error.png'),fullPage:true})
  await page.unroute(`**/api/v1/clients/${clientID}/audit-logs?*`)
  await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(table).toBeVisible()
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${clientRole}' AND permission_key='clients.view'`)
  await page.getByRole('button',{name:'Refresh audit history',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Access denied',exact:true})).toBeVisible();await expect(table).toHaveCount(0)
  await page.goto('/app/audit');await expect(table).toBeVisible();expect(await table.innerText()).not.toContain(clientID)
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${rootRole}' AND permission_key='audit.view'`)
  await page.getByRole('button',{name:'Refresh audit history',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Access denied',exact:true})).toBeVisible()
  expect(historyHash()).toBe(before)
})

test('pricing retains exact versions and immutable collections through lost-response recovery and cost-access changes', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const client='f5555555-5555-4555-8555-555555555555', actor='f1111111-1111-4111-8111-111111111111', role='f2222222-2222-4222-8222-222222222222', path=`/app/clients/${client}/pricing`, base=`/api/v1/clients/${client}/pricing`
  database(`INSERT INTO app.client_scopes(id) VALUES('${client}'); INSERT INTO app.clients(id,name) VALUES('${client}','Synthetic Pricing Client'); INSERT INTO app.users(id,email,display_name,password_hash) SELECT '${actor}','pricing.browser.fixture@example.com','Pricing Fixture',password_hash FROM app.users WHERE id='44444444-4444-4444-8444-444444444444'; INSERT INTO app.roles(id,role_key,display_name) VALUES('${role}','pricing_browser_fixture','Synthetic pricing operator'); INSERT INTO app.role_permissions(id,role_id,permission_key) SELECT gen_random_uuid(),'${role}',permission_key FROM app.permissions WHERE permission_key IN ('pricing.view','pricing.manage','billing.view','billing.create','billing.update'); INSERT INTO app.user_roles(id,user_id,role_id,scope_kind,client_id) VALUES(gen_random_uuid(),'${actor}','${role}','client','${client}');`)
  const reads:string[]=[]
  page.on('request',r=>{if(r.method()==='GET'&&r.url().includes('/api/v1/clients'))reads.push(new URL(r.url()).pathname)})
  await page.goto(path)
  await page.getByLabel('Email',{exact:true}).fill('pricing.browser.fixture@example.com')
  await page.getByLabel('Password',{exact:true}).fill('clearly synthetic browser password')
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  await expect(page.getByRole('heading',{name:'No pricing agreements',exact:true})).toBeVisible()
  await page.getByRole('link',{name:'Create pricing agreement',exact:true}).click()
  await expect(page.locator('[aria-current="page"]')).toHaveText('Create pricing agreement')
  await page.getByLabel('Agreement title').fill('Synthetic exact pricing agreement')
  await page.getByRole('combobox',{name:'Currency',exact:true}).selectOption('USD')
  await page.getByLabel('Line 1 description',{exact:true}).fill('Synthetic recurring service')
  await page.getByLabel('Line 1 quantity',{exact:true}).fill('1.5')
  await page.getByLabel('Line 1 unit price',{exact:true}).fill('1.01')
  await page.getByLabel('Line 1 discount (%)',{exact:true}).fill('25')
  await page.getByLabel('Line 1 tax (%)',{exact:true}).fill('10')
  await page.getByLabel('Line 1 internal unit cost',{exact:true}).fill('0.07')
  await page.getByLabel('Pricing note').fill('Synthetic private pricing note')
  await page.getByRole('button',{name:'Preview pricing',exact:true}).click()
  await expect(page.getByText(/Preview matches/)).toBeVisible()
  await expect(page.getByText('USD 1.25',{exact:true})).toHaveCount(2)
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);expect(await page.evaluate(()=>document.documentElement.scrollWidth===document.documentElement.clientWidth)).toBe(true);await markTaskScreenshot(page);await page.screenshot({path:testInfo.outputPath(`pricing-form-${viewport.width}.png`),fullPage:true})
  }
  await page.getByRole('button',{name:'Save pricing agreement',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Pricing agreement',exact:true})).toBeVisible()
  const sheet=new URL(page.url()).pathname.split('/').at(-1)!
  expect(database(`SELECT total_minor::text FROM app.pricing_versions WHERE sheet_id='${sheet}' AND revision=1`)).toBe('125')
  expect(reads.every(p=>p.startsWith(base))).toBe(true)
  await page.setViewportSize({width:1440,height:1000})
  await markTaskScreenshot(page);await page.screenshot({path:testInfo.outputPath('pricing-history-desktop.png'),fullPage:true})
  const commands:string[]=[]
  await page.route('**/pricing/*/versions/*/collections',async route=>{if(route.request().method()!=='POST')return route.continue();commands.push(route.request().postData()!);const response=await route.fetch();if(commands.length===1){expect(response.status()).toBe(201);await route.abort('failed')}else await route.fulfill({response})})
  await page.getByLabel('I confirm this fixed collection amount.').check()
  await page.getByRole('button',{name:'Create collection from version',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'Confirming collection',exact:true})).toContainText('unconfirmed')
  await page.goBack()
  await expect(page.getByRole('dialog',{name:'Confirming collection',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Retry original collection',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'Collection confirmed',exact:true})).toContainText('No duplicate')
  expect(commands).toHaveLength(2);expect(commands[0]).toBe(commands[1])
  await page.getByRole('button',{name:'Open collection',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Copied pricing terms',exact:true})).toBeVisible()
  const collection=new URL(page.url()).pathname.split('/').at(-1)!, financial=`/app/clients/${client}/billing/${collection}`
  expect(database(`SELECT count(*)::text FROM app.collections WHERE client_id='${client}'`)).toBe('1')
  expect(database(`SELECT count(*)::text FROM app.audit_events WHERE resource_id='${collection}' AND event_name='billing.created'`)).toBe('1')
  const retained=()=>database(`SELECT md5(string_agg(row_to_json(l)::text,'' ORDER BY position)) FROM app.pricing_snapshot_lines l WHERE collection_id='${collection}'`), original=retained()
  await page.getByRole('link',{name:'Edit collection',exact:true}).click()
  await expect(page.getByLabel('Collection amount')).toHaveAttribute('readonly','')
  await page.getByLabel('Collection description').fill('Synthetic copied collection metadata')
  await page.getByRole('button',{name:'Save collection',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Collection details',exact:true})).toBeVisible()
  await page.goto(path+'/'+sheet+'/new-version')
  await page.getByLabel('Agreement title').fill('Synthetic revised pricing')
  await page.getByLabel('Line 1 unit price',{exact:true}).fill('2.00')
  await page.getByRole('button',{name:'Preview pricing',exact:true}).click()
  await expect(page.getByText(/Preview matches/)).toBeVisible()
  await page.getByRole('button',{name:'Save new version',exact:true}).click()
  await expect(page.getByRole('link',{name:'Version 2 · Synthetic revised pricing',exact:true})).toBeVisible()
  expect(database(`SELECT amount_minor::text FROM app.collections WHERE id='${collection}'`)).toBe('125');expect(retained()).toBe(original)
  await page.getByRole('link',{name:'Version 1 · Synthetic exact pricing agreement',exact:true}).click()
  await expect(page.getByText(/Superseded on its start date/).first()).toBeVisible()
  await expect(page.getByRole('button',{name:'Create collection from version',exact:true})).toBeDisabled()
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${role}' AND permission_key='pricing.manage'`)
  await page.getByRole('button',{name:'Refresh agreement',exact:true}).click()
  // Session refresh explicitly updates the actor/grant query partition.
  await page.goto('/app/access');await page.getByRole('button',{name:'Refresh access',exact:true}).click();await page.goto(path+'/'+sheet)
  await expect(page.getByRole('heading',{name:'Pricing agreement',exact:true})).toBeVisible()
  await expect(page.getByText(/Internal aggregate cost/)).toHaveCount(0)
  await expect(page.getByRole('link',{name:'Create new version',exact:true})).toHaveCount(0)
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${role}' AND permission_key='pricing.view'`)
  await page.goto('/app/access');await page.getByRole('button',{name:'Refresh access',exact:true}).click();await page.goto(financial)
  await expect(page.getByRole('heading',{name:'Copied pricing terms',exact:true})).toBeVisible()
  await expect(page.getByRole('link',{name:'Open retained pricing version',exact:true})).toHaveCount(0)
  await expect(page.getByText('Synthetic private pricing note',{exact:true})).toHaveCount(0)
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth===document.documentElement.clientWidth)).toBe(true);await markTaskScreenshot(page);await page.screenshot({path:testInfo.outputPath('pricing-snapshot-mobile.png'),fullPage:true})
  expect(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0})
})

test('finance preserves exact currencies, reconciles a lost payment response and retains cancelled history', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const clientID='b5555555-5555-4555-8555-555555555555', actorID='b1111111-1111-4111-8111-111111111111', roleID='b2222222-2222-4222-8222-222222222222', path=`/app/clients/${clientID}/billing`, base=`/api/v1/clients/${clientID}/billing`
  database(`
    INSERT INTO app.client_scopes(id) VALUES('${clientID}');
    INSERT INTO app.clients(id,name) VALUES('${clientID}','Synthetic Finance Client');
    INSERT INTO app.users(id,email,display_name,password_hash) SELECT '${actorID}','finance.browser.fixture@example.com','Finance-only Fixture',password_hash FROM app.users WHERE id='44444444-4444-4444-8444-444444444444';
    INSERT INTO app.roles(id,role_key,display_name) VALUES('${roleID}','finance_browser_fixture','Synthetic finance operator');
    INSERT INTO app.role_permissions(id,role_id,permission_key) SELECT gen_random_uuid(),'${roleID}',permission_key FROM app.permissions WHERE permission_key IN ('billing.view','billing.create','billing.update','billing.delete');
    INSERT INTO app.user_roles(id,user_id,role_id,scope_kind,client_id) VALUES(gen_random_uuid(),'${actorID}','${roleID}','client','${clientID}');
  `)
  const privateReads:string[]=[]
  page.on('request',request=>{if(request.method()==='GET' && request.url().includes('/api/v1/clients')) privateReads.push(new URL(request.url()).pathname)})
  await page.goto(path)
  await page.getByLabel('Email',{exact:true}).fill('finance.browser.fixture@example.com')
  await page.getByLabel('Password',{exact:true}).fill('clearly synthetic browser password')
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Finance',exact:true})).toBeVisible()
  await expect(page.getByText('No balances recorded yet.')).toBeVisible()
  expect(privateReads.every(p=>p.startsWith(base))).toBe(true)
  const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10)
  async function create(description:string,currency:string,amount:string) {
    await page.getByRole('link',{name:'Create collection',exact:true}).click()
    await page.getByLabel('Collection description').fill(description)
    await page.getByRole('combobox',{name:'Currency',exact:true}).selectOption(currency)
    await page.getByLabel('Collection amount').fill(amount)
    await page.getByLabel('Due date (UTC calendar)').fill(yesterday)
    await page.getByRole('button',{name:'Create collection',exact:true}).click()
    await expect(page.getByRole('heading',{name:'Collection details',exact:true})).toBeVisible()
    return new URL(page.url()).pathname.split('/').at(-1)!
  }
  const usd=await create('Synthetic USD collection','USD','100.00')
  await expect(page.getByText('Overdue',{exact:true})).toBeVisible()
  await page.getByRole('link',{name:'Finance',exact:true}).click()
  const kwd=await create('Synthetic KWD collection','KWD','1.001')
  await page.getByRole('link',{name:'Finance',exact:true}).click()
  await create('Synthetic JPY collection','JPY','100')
  await page.getByRole('link',{name:'Finance',exact:true}).click()
  const balances=page.getByRole('table',{name:'Balances by currency'})
  await expect(balances).toContainText('USD 100.00')
  await expect(balances).toContainText('KWD 1.001')
  await expect(balances).toContainText('JPY 100')
  await expect(balances.locator('tbody tr')).toHaveCount(3)
  for(const viewport of [{width:1440,height:1000},{width:820,height:1050},{width:390,height:844}]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth===document.documentElement.clientWidth)).toBe(true)
    await markTaskScreenshot(page)
    await page.screenshot({path:testInfo.outputPath(`finance-${viewport.width}.png`),fullPage:true})
  }
  await page.setViewportSize({width:1440,height:1000})
  await page.getByRole('link',{name:'Open Synthetic USD collection',exact:true}).click()
  await page.getByLabel('Payment amount (USD)').fill('1.001')
  await page.getByRole('button',{name:'Record payment',exact:true}).click()
  await expect(page.getByText(/Use at most 2 decimal places/)).toBeVisible()
  expect(database(`SELECT count(*)::text FROM app.payments WHERE collection_id='${usd}'`)).toBe('0')
  await page.getByLabel('Payment amount (USD)').fill('25.00')
  await page.getByLabel('Payment date (UTC calendar)').fill(yesterday)
  await page.getByLabel('Payment reference').fill('Synthetic private finance reference')
  // The real API commits; deliberately discard only its first transport response.
  let lost=true
  const commands:string[]=[]
  await page.route('**/api/v1/clients/*/billing/*/payments',async route=>{
    if(route.request().method()!=='POST') {await route.continue();return}
    commands.push(route.request().postData()!)
    if(lost) {lost=false;const response=await route.fetch();expect(response.status()).toBe(201);await route.abort('failed')}
    else await route.continue()
  })
  await page.getByRole('button',{name:'Record payment',exact:true}).click()
  await expect(page.getByRole('button',{name:'Retry original payment',exact:true})).toBeVisible()
  expect(database(`SELECT count(*)::text FROM app.payments WHERE collection_id='${usd}'`)).toBe('1')
  // Browser Back changes the route, but the command and modal survive above routes.
  await page.goBack()
  await expect(page.getByRole('button',{name:'Retry original payment',exact:true})).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog',{name:'Confirming payment',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Retry original payment',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'Payment confirmed',exact:true})).toContainText('No second payment')
  expect(commands).toHaveLength(2)
  expect(commands[1]).toBe(commands[0])
  expect(JSON.parse(commands[0]!).expected_revision).toBe('1')
  await page.getByRole('button',{name:'Return to collection',exact:true}).click()
  await expect(page.getByRole('table',{name:'Collection payments'})).toContainText('USD 25.00')
  await expect(page.getByText('Synthetic private finance reference',{exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:/Reveal reference for payment/}).click()
  await expect(page.getByText('Synthetic private finance reference',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:/Hide reference for payment/}).click()
  await expect(page.getByText('Synthetic private finance reference',{exact:true})).toHaveCount(0)
  await markTaskScreenshot(page)
  await page.screenshot({path:testInfo.outputPath('finance-payment-history.png'),fullPage:true})
  await page.getByRole('link',{name:'Edit collection',exact:true}).click()
  await expect(page.getByLabel('Collection amount')).toHaveAttribute('readonly','')
  await page.getByLabel('Internal note').fill('Synthetic updated finance note')
  await page.getByRole('button',{name:'Save collection',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Collection details',exact:true})).toBeVisible()
  // A second legitimate API write invalidates the revision currently displayed.
  const csrf=(await page.context().cookies()).find(c=>c.name==='else_csrf')!.value
  const competing=await page.request.put(`${base}/${usd}`,{headers:{Origin:'http://127.0.0.1:5173','X-CSRF-Token':csrf},data:{description:'Synthetic USD collection',internal_note:'Synthetic concurrent note',amount_minor:'10000',currency:'USD',due_date:yesterday,expected_revision:'3'}})
  expect(competing.status()).toBe(200)
  await page.getByLabel('Payment amount (USD)').fill('1.00')
  await page.getByRole('button',{name:'Record payment',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'Payment not recorded',exact:true})).toBeVisible()
  expect(database(`SELECT count(*)::text FROM app.payments WHERE collection_id='${usd}'`)).toBe('1')
  await page.getByRole('button',{name:'Reload collection before retrying',exact:true}).click()
  await expect(page.getByText('Synthetic concurrent note',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Cancel collection',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'Cancel collection?',exact:true})).toContainText('not refunded')
  await page.getByRole('button',{name:'Keep collection',exact:true}).click()
  expect(database(`SELECT CASE WHEN cancelled_at IS NULL THEN 'active' ELSE 'cancelled' END FROM app.collections WHERE id='${usd}'`)).toBe('active')
  await page.getByRole('button',{name:'Cancel collection',exact:true}).click()
  await markTaskScreenshot(page)
  await page.screenshot({path:testInfo.outputPath('finance-cancellation.png'),fullPage:true})
  await page.getByRole('button',{name:'Confirm cancellation',exact:true}).click()
  await expect(page.getByText('Collection cancelled. Payment history retained.',{exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'Record payment',exact:true})).toHaveCount(0)
  await expect(page.getByRole('table',{name:'Collection payments'})).toContainText('USD 25.00')
  expect(database(`SELECT paid_minor::text FROM app.collections WHERE id='${usd}'`)).toBe('2500')
  expect(database(`SELECT count(*)::text FROM app.payments WHERE collection_id='${usd}'`)).toBe('1')
  expect(database(`SELECT string_agg(event_name,',' ORDER BY occurred_at,id) FROM app.audit_events WHERE resource_id='${usd}'`)).toBe('billing.created,billing.payment_recorded,billing.updated,billing.updated,billing.cancelled')
  expect(database(`SELECT count(*)::text FROM app.audit_events WHERE resource_id='${usd}' AND (before_state::text||after_state::text) LIKE '%Synthetic private finance reference%'`)).toBe('0')
  expect(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0})
  await page.getByRole('link',{name:'Finance',exact:true}).click()
  await expect(balances).toContainText('USD 25.00')
  await page.goto(`/app/clients/22222222-2222-4222-8222-222222222222/billing`)
  await expect(page.getByRole('heading',{name:'Access denied',exact:true})).toBeVisible()
  database(`UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id='${clientID}'`)
  await page.goto(`${path}/${kwd}`)
  await expect(page.getByRole('heading',{name:'Collection details',exact:true})).toBeVisible()
  await page.getByLabel('Payment amount (KWD)').fill('0.001')
  await page.getByRole('button',{name:'Record payment',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'Payment not recorded',exact:true})).toBeVisible()
  expect(database(`SELECT count(*)::text FROM app.payments WHERE collection_id='${kwd}'`)).toBe('0')
  await page.getByRole('button',{name:'Reload collection before retrying',exact:true}).click()
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${roleID}' AND permission_key='billing.view'`)
  // An in-flight origin read can detect revocation before the refresh button is clicked.
  // Re-enter the route with a fresh session to assert the same denial deterministically.
  await page.goto(`${path}/${kwd}`)
  await expect(page.getByRole('heading',{name:'Access denied',exact:true})).toBeVisible()
  await expect(page.getByRole('table',{name:'Collection payments'})).toHaveCount(0)
})

test('overview reconciles real sources in one bounded request and omits revoked domains', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const client='a5555555-5555-4555-8555-555555555555',actor='a1111111-1111-4111-8111-111111111111',role='a2222222-2222-4222-8222-222222222222',path=`/app/clients/${client}`,base=`/api/v1/clients/${client}`
  database(`
    INSERT INTO app.client_scopes(id) VALUES('${client}');
    INSERT INTO app.clients(id,name) VALUES('${client}','Synthetic overview client');
    INSERT INTO app.users(id,email,display_name,password_hash) SELECT '${actor}','overview.fixture@example.com','Overview Fixture',password_hash FROM app.users WHERE id='44444444-4444-4444-8444-444444444444';
    INSERT INTO app.roles(id,role_key,display_name) VALUES('${role}','overview_fixture','Synthetic overview role');
    INSERT INTO app.role_permissions(id,role_id,permission_key) SELECT gen_random_uuid(),'${role}',permission_key FROM app.permissions WHERE permission_key IN ('clients.view','tasks.view','tasks.create','reminders.view','reminders.create','billing.view','billing.create','billing.update','billing.delete','activity.view');
    INSERT INTO app.user_roles(id,user_id,role_id,scope_kind,client_id) VALUES(gen_random_uuid(),'${actor}','${role}','client','${client}');
  `)
  await page.goto(path)
  await page.getByLabel('Email',{exact:true}).fill('overview.fixture@example.com')
  await page.getByLabel('Password',{exact:true}).fill('clearly synthetic browser password')
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Synthetic overview client',exact:true})).toBeVisible()
  await expect(page.getByText('No overdue tasks.',{exact:true})).toBeVisible()
  await expect(page.getByText('No balances recorded yet.',{exact:true})).toBeVisible()
  await markTaskScreenshot(page)
  await page.screenshot({path:testInfo.outputPath('overview-empty.png'),fullPage:true})

  const seeded=await page.evaluate(async({client,actor})=>{
    const token=document.cookie.split('; ').find(c=>c.startsWith('else_csrf='))?.slice('else_csrf='.length)??''
    const headers={'Content-Type':'application/json','X-CSRF-Token':token},base=`/api/v1/clients/${client}`
    async function post(path:string,body:unknown){const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});if(!r.ok)throw new Error(`Synthetic seed request rejected ${path} ${r.status}`);return (await r.json()).data}
    for(let i=1;i<=12;i++){
      // Separate task and reminder deadlines from the overview request clock.
      const scheduled=new Date(Date.now()+(i<=6?-86400000:(i-6)*3600000))
      const due=scheduled.toISOString()
      await post('/tasks',{title:`Synthetic ${i<=6?'overdue':'upcoming'} task ${i} · A deliberately long operational title for wrapping`,description:'Synthetic private task description',priority:'urgent',assignee_id:null,start_at:null,due_at:due,tags:[]})
      const reminderTime=scheduled
      await post('/reminders',{title:`Synthetic ${i<=6?'due':'upcoming'} reminder ${i}`,description:'Synthetic private reminder description',owner_id:actor,scheduled_local:new Date(reminderTime.getTime()+10800000).toISOString().slice(0,23),timezone:'Europe/Istanbul',utc_offset_seconds:10800,resource:null})
    }
    const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10)
    for(const currency of ['USD','USD','EUR','GBP','TRY','JPY','KWD'])await post('/billing',{description:'Synthetic overview obligation',internal_note:'Synthetic private finance note',amount_minor:currency==='USD'?'9223372036854775807':'100',currency,due_date:yesterday})
    const cancelled=await post('/billing',{description:'Synthetic cancelled overview obligation',internal_note:'',amount_minor:'100',currency:'USD',due_date:yesterday})
    await post(`/billing/${cancelled.id}/payments`,{command_id:crypto.randomUUID(),amount_minor:'25',currency:'USD',paid_on:new Date().toISOString().slice(0,10),method:'cash',reference:'Synthetic private payment reference',note:'',expected_revision:cancelled.revision})
    await post(`/billing/${cancelled.id}/cancel`,{expected_revision:'2',confirm:true})
    const summary=await(await fetch(base+'/billing/summary')).json()
    return {summary:summary.data}
  },{client,actor})
  const reads:string[]=[]
  page.on('request',r=>{const url=new URL(r.url());if(url.pathname.startsWith('/api/v1/'))reads.push(url.pathname+url.search)})
  const auditBefore=database(`SELECT count(*)::text FROM app.audit_events WHERE client_id='${client}'`)
  const aggregatePromise=page.waitForResponse(r=>new URL(r.url()).pathname===base+'/overview')
  await page.getByRole('button',{name:'Refresh overview',exact:true}).click()
  const aggregate=(await(await aggregatePromise).json()).data
  await expect(page.getByRole('heading',{name:'Financial position',exact:true})).toBeVisible()
  expect(aggregate.finance.currencies).toEqual(seeded.summary)
  expect(aggregate.finance.currencies.find((t:{currency:string})=>t.currency==='USD')).toMatchObject({amount_minor:'18446744073709551614',cancelled_amount_minor:'100',cancelled_paid_minor:'25'})
  expect(reads.filter(v=>v===base+'/overview')).toHaveLength(1)
  expect(reads.every(v=>v===base+'/overview'||v==='/api/v1/auth/session')).toBe(true)
  for(const name of ['Overdue tasks','Tasks due soon','Due reminders','Upcoming reminders'])await expect(page.getByRole('list',{name,exact:true}).getByRole('listitem')).toHaveCount(5)
  await expect(page.getByRole('list',{name:'Recent client activity',exact:true}).getByRole('listitem')).toHaveCount(5)
  await expect(page.getByText('USD 184,467,440,737,095,516.14',{exact:true})).toHaveCount(3)
  expect(await page.locator('main').innerText()).not.toContain('Synthetic private')
  expect(database(`SELECT count(*)::text FROM app.audit_events WHERE client_id='${client}'`)).toBe(auditBefore)
  for(const viewport of [{width:1440,height:1000},{width:820,height:1050},{width:390,height:844}]){
    await page.setViewportSize(viewport);await markTaskScreenshot(page)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth===document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({path:testInfo.outputPath(`overview-${viewport.width}.png`),fullPage:true})
  }
  const firstTask=page.getByRole('list',{name:'Overdue tasks',exact:true}).getByRole('link').first()
  const taskTitle=await firstTask.innerText()
  await firstTask.focus();await expect(firstTask).toBeFocused();await page.keyboard.press('Enter')
  await expect(page.getByRole('heading',{name:taskTitle,exact:true})).toBeVisible()
  reads.length=0
  await page.getByRole('link',{name:'Overview',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Synthetic overview client',exact:true})).toBeVisible()
  expect(reads.filter(v=>v===base+'/overview')).toHaveLength(1)
  expect(reads.every(v=>v===base+'/overview'||v==='/api/v1/auth/session')).toBe(true)

  await page.route(`**${base}/overview`,async route=>{await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'internal_error',message:'Synthetic private failure'}})})})
  await page.getByRole('button',{name:'Refresh overview',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Overview unavailable',exact:true})).toBeVisible()
  await expect(page.getByRole('heading',{name:'Financial position',exact:true})).toHaveCount(0)
  expect(await page.locator('main').innerText()).not.toContain('Synthetic private failure')
  await markTaskScreenshot(page);await page.screenshot({path:testInfo.outputPath('overview-error-mobile.png'),fullPage:true})
  await page.unroute(`**${base}/overview`)
  await page.getByRole('button',{name:'Try again',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Financial position',exact:true})).toBeVisible()
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${role}' AND permission_key IN ('billing.view','tasks.view')`)
  await page.getByRole('button',{name:'Refresh overview',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Synthetic overview client',exact:true})).toBeVisible()
  await expect(page.getByRole('heading',{name:'Financial position',exact:true})).toHaveCount(0)
  await expect(page.getByRole('heading',{name:'Overdue tasks',exact:true})).toHaveCount(0)
  await expect(page.getByRole('heading',{name:'Due reminders',exact:true})).toBeVisible()
  await expect(page.getByText('Task created.',{exact:true})).toHaveCount(0)
  database(`UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id='${client}'`)
  await page.getByRole('button',{name:'Refresh overview',exact:true}).click()
  await expect(page.getByText(/overview and history remain readable/)).toBeVisible()
  await page.getByRole('link',{name:'Profile',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Profile',exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'Archive client',exact:true})).toHaveCount(0)
  await page.getByRole('link',{name:'Overview',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Synthetic overview client',exact:true})).toBeVisible()
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${role}' AND permission_key='clients.view'`)
  await page.getByRole('button',{name:'Refresh overview',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Access denied',exact:true})).toBeVisible()
  await expect(page.getByRole('heading',{name:'Due reminders',exact:true})).toHaveCount(0)
  expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0)
})

test('integration metadata, confirmed local disable, uncertain outcome recovery and fresh scope', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  database(readFileSync(new URL('./integration-fixtures.sql',import.meta.url),'utf8'))
  const client='f8555555-5555-4555-8555-555555555555',role='f8222222-2222-4222-8222-222222222222'
  const first='f8900000-0000-4000-8000-000000000001',second='f8900000-0000-4000-8000-000000000002'
  const path=`/app/clients/${client}/integrations`,base=`/api/v1/clients/${client}/integrations`
  await page.goto(path)
  await page.getByLabel('Email',{exact:true}).fill('integration.fixture@example.com')
  await page.getByLabel('Password',{exact:true}).fill('clearly synthetic browser password')
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  await expect(page).toHaveURL(new RegExp(path+'$'))
  const table=page.getByRole('table',{name:'Integration connections',exact:true})
  await expect(table.locator('tbody tr')).toHaveCount(25)
  await expect(table).toContainText('Local use disabled · Manual action required')
  expect(await page.locator('main').innerText()).not.toContain('8000001')
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
    await page.setViewportSize(viewport);await markTaskScreenshot(page)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth===document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({path:testInfo.outputPath(`integrations-${viewport.width}.png`),fullPage:true})
  }
  await page.getByRole('button',{name:'Next',exact:true}).click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table).toContainText('f8900000-0000-4000-8000-000000000026')
  await page.getByRole('button',{name:'Refresh integrations',exact:true}).click()
  await expect(table.locator('tbody tr')).toHaveCount(25)
  await expect(page.getByRole('button',{name:'Previous',exact:true})).toBeDisabled()
  await page.getByRole('link',{name:new RegExp(first)}).click()
  const disable=page.getByRole('button',{name:'Disable local use',exact:true})
  await expect(disable).toBeVisible()
  await disable.focus();await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toContainText('Remote revocation is unavailable')
  await page.keyboard.press('Escape');await expect(disable).toBeFocused()
  await disable.click()
  await markTaskScreenshot(page)
  await page.screenshot({path:testInfo.outputPath('integration-confirm-mobile.png'),fullPage:true})
  // Change metadata after opening confirmation: the server must reject the old revision.
  database(`UPDATE app.integration_connections SET revision=revision+1,updated_at=clock_timestamp() WHERE id='${first}'`)
  const posts:string[]=[]
  page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/disconnect'))posts.push(request.postData()??'')})
  await page.getByRole('button',{name:'Confirm local disable',exact:true}).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Reload current data')
  await expect(page.getByRole('button',{name:'Confirm local disable',exact:true})).toBeDisabled()
  expect(JSON.parse(posts[0]!)).toEqual({revision:'9007199254740993',confirmed:true})
  expect(posts).toHaveLength(1)
  await page.getByRole('button',{name:'Close and reload',exact:true}).click()
  await expect(disable).toBeEnabled()
  const before=database(`SELECT count(*)::text FROM app.audit_events WHERE resource_id='${first}' AND event_name='integration_connection.updated'`)
  // Let the real API commit, then lose the response. The UI must read, never resubmit.
  await page.route(`**${base}/${first}/disconnect`,async route=>{
    const response=await route.fetch();expect(response.status()).toBe(200)
    await route.abort('failed')
  })
  await disable.click()
  await page.getByRole('button',{name:'Confirm local disable',exact:true}).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('outcome may be uncertain')
  expect(posts).toHaveLength(2)
  expect(JSON.parse(posts[1]!)).toEqual({revision:'9007199254740994',confirmed:true})
  await page.unroute(`**${base}/${first}/disconnect`)
  await page.getByRole('button',{name:'Close and reload',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Remote revocation requires manual action',exact:true})).toBeVisible()
  await expect(disable).toHaveCount(0)
  expect(posts).toHaveLength(2)
  expect(database(`SELECT count(*)::text FROM app.audit_events WHERE resource_id='${first}' AND event_name='integration_connection.updated'`)).toBe(String(Number(before)+1))
  expect(database(`SELECT state || ':' || revision::text || ':' || generation::text FROM app.integration_connections WHERE id='${first}'`)).toBe('revocation_failed:9007199254740995:2')
  await markTaskScreenshot(page);await page.screenshot({path:testInfo.outputPath('integration-manual-mobile.png'),fullPage:true})

  await page.getByRole('link',{name:'Integrations',exact:true}).click()
  await page.getByRole('link',{name:new RegExp(second)}).click()
  await disable.click();await page.getByRole('button',{name:'Confirm local disable',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Remote revocation requires manual action',exact:true})).toBeVisible()
  await expect(page.getByRole('status').filter({hasText:'Local use disabled. Remote revocation remains unverified.'})).toBeVisible()
  const noOp=await page.evaluate(async({base,second})=>{
    const csrf=document.cookie.split('; ').find(v=>v.startsWith('else_csrf='))?.slice('else_csrf='.length)??''
    const response=await fetch(`${base}/${second}/disconnect`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({revision:'2',confirmed:true})})
    return {status:response.status,body:await response.json()}
  },{base,second})
  expect(noOp).toMatchObject({status:200,body:{data:{state:'revocation_failed',revision:'2'},revocation:{status:'unavailable',manual_action_required:true}}})
  expect(database(`SELECT count(*)::text FROM app.audit_events WHERE resource_id='${second}' AND event_name='integration_connection.updated'`)).toBe('1')
  await page.setViewportSize({width:1440,height:1000});await markTaskScreenshot(page)
  await page.screenshot({path:testInfo.outputPath('integration-manual-desktop.png'),fullPage:true})
  // Revoke manage while preserving view, then archive the client: history is retained.
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${role}' AND permission_key='integrations.manage'`)
  await page.goto(path+'/f8900000-0000-4000-8000-000000000003')
  await expect(page.getByRole('heading',{name:'Meta Ads',exact:true})).toBeVisible()
  await expect(disable).toHaveCount(0)
  database(`UPDATE app.clients SET archived_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id='${client}'`)
  await page.getByRole('button',{name:'Reload connection',exact:true}).click()
  await expect(page.getByText('This client is archived. Connection history remains readable; changes are unavailable.',{exact:true})).toBeVisible()
  await expect(disable).toHaveCount(0)
  database(`UPDATE app.role_permissions SET revoked_at=clock_timestamp() WHERE role_id='${role}' AND permission_key='integrations.view'`)
  await page.getByRole('button',{name:'Reload connection',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Access denied',exact:true})).toBeVisible()
  await expect(page.getByRole('heading',{name:'Meta Ads',exact:true})).toHaveCount(0)
  expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0)
})
