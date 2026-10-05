import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
const actor = 'f0111111-1111-4111-8111-111111111111'
const role = 'f0222222-2222-4222-8222-222222222222'
let clientID = '',
  firstID = '',
  secondID = '',
  connectionID = ''
function database(sql: string) {
  const container = process.env.AUTH_TEST_CONTAINER
  if (!container || !/^[a-f0-9]{12,64}$/.test(container))
    throw new Error('An isolated browser-test container is required.')
  return execFileSync(
    'docker',
    [
      '--host=unix:///var/run/docker.sock',
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'else',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atc',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim()
}
async function login(page: Page, path = '/app/clients') {
  await page.goto(path)
  await page
    .getByLabel('Email', { exact: true })
    .fill('websites.browser.fixture@example.com')
  await page
    .getByLabel('Password', { exact: true })
    .fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(
    page.getByRole('navigation', { name: 'Application' }),
  ).toBeVisible()
}
async function request(
  page: Page,
  path: string,
  body?: unknown,
  method = 'POST',
) {
  const csrf = await page.evaluate(
    () =>
      document.cookie
        .split('; ')
        .find((v) => v.startsWith('else_csrf='))
        ?.slice(10) ?? '',
  )
  return page.request.fetch(path, {
    method,
    headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin },
    ...(body === undefined ? {} : { data: body }),
  })
}
test('independent website creation, primary changes, editing, switching and explicit provider association', async ({
  page,
}) => {
  test.setTimeout(120_000)
  if (database(`SELECT count(*) FROM app.users WHERE id='${actor}'`) === '0')
    database(
      `INSERT INTO app.users(id,email,display_name,password_hash) SELECT '${actor}','websites.browser.fixture@example.com','Synthetic website operator',password_hash FROM app.users WHERE id='44444444-4444-4444-8444-444444444444'; INSERT INTO app.roles(id,role_key,display_name) VALUES('${role}','website_browser_fixture','Synthetic website manager'); INSERT INTO app.role_permissions(id,role_id,permission_key) SELECT gen_random_uuid(),'${role}',permission_key FROM app.permissions WHERE permission_key IN ('clients.create','clients.view','clients.update','clients.archive','integrations.view','integrations.manage','analytics.view','activity.view'); INSERT INTO app.user_roles(id,user_id,role_id,scope_kind) VALUES(gen_random_uuid(),'${actor}','${role}','global');`,
    )
  await login(page)
  const created = await request(page, '/api/v1/clients', {
    name: 'Synthetic website account',
    legal_name: '',
    website: '',
    notes: '',
    contacts: [],
    tags: [],
  })
  expect(created.status()).toBe(201)
  clientID = (await created.json()).data.id
  const base = `/app/clients/${clientID}/websites`
  await page.goto(base)
  await expect(
    page.getByText('No websites in this view', { exact: true }),
  ).toBeVisible()
  for (const [name, url] of [
    ['Clients', 'example.com'],
    ['Synthetic boutique', 'https://shop.example.com/store'],
  ]) {
    await page.getByRole('button', { name: 'Add website', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: 'Add website' })
    await drawer.getByLabel('Website name', { exact: true }).fill(name!)
    await drawer.getByLabel('Website URL', { exact: true }).fill(url!)
    await drawer
      .getByLabel('Description', { exact: true })
      .fill('Synthetic property description')
    await drawer
      .getByRole('button', { name: 'Save website', exact: true })
      .click()
    await expect(page).toHaveURL(new RegExp(base + '/[a-f0-9-]{36}$'))
    await expect(
      page.getByRole('heading', { name: name!, exact: true }),
    ).toBeVisible()
    if (!firstID) firstID = page.url().split('/').at(-1)!
    else secondID = page.url().split('/').at(-1)!
    await page
      .getByRole('button', { name: 'Set as primary', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: 'Set primary website' })
      .getByRole('button', { name: 'Confirm', exact: true })
      .click()
    await expect(
      page.getByText('Primary website updated.', { exact: true }),
    ).toBeVisible()
    await page.goto(base)
  }
  expect(
    database(
      `SELECT count(*) FROM app.client_websites WHERE client_id='${clientID}' AND is_primary AND archived_at IS NULL`,
    ),
  ).toBe('1')
  expect(
    database(
      `SELECT is_primary FROM app.client_websites WHERE id='${firstID}'`,
    ),
  ).toBe('f')
  await page.goto(`${base}/${secondID}`)
  await page.getByRole('button', { name: 'Edit website', exact: true }).click()
  const edit = page.getByRole('dialog', { name: 'Edit website' })
  await edit
    .getByLabel('Website URL', { exact: true })
    .fill('https://shop.example.com/collection')
  await edit.getByRole('button', { name: 'Save website', exact: true }).click()
  await expect(edit).not.toBeVisible()
  await expect(
    page.getByText('https://shop.example.com/collection', { exact: true }),
  ).toBeVisible()
  await page
    .getByRole('combobox', { name: 'Switch website', exact: true })
    .selectOption(firstID)
  await expect(page).toHaveURL(`${base}/${firstID}`)
  await expect(
    page.getByRole('heading', { name: 'Clients', exact: true }),
  ).toBeVisible()
  const connection = await request(
    page,
    `/api/v1/clients/${clientID}/integrations/ga4`,
    { property_id: '99' + BigInt('0x' + clientID.slice(0, 8)).toString() },
  )
  expect(connection.status()).toBe(201)
  connectionID = (await connection.json()).data.id
  await page.goto(`${base}/${firstID}/integrations`)
  await page
    .getByRole('combobox', { name: 'Client connection', exact: true })
    .selectOption(connectionID)
  await expect(
    page.getByRole('button', { name: 'Assign connection', exact: true }),
  ).toBeDisabled()
  await page
    .getByRole('checkbox', {
      name: "I confirm that this connection's data belongs to this website.",
    })
    .check()
  await page
    .getByRole('button', { name: 'Assign connection', exact: true })
    .click()
  await expect(
    page.getByText('Connection assigned to this website.', { exact: true }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Open reports', exact: true }).click()
  await expect(page).toHaveURL(`${base}/${firstID}/analytics/${connectionID}`)
  await page.getByLabel('Start date', { exact: true }).fill('2026-10-01')
  await page.getByLabel('End date', { exact: true }).fill('2026-10-03')
  await page
    .getByRole('button', { name: 'Load stored reports', exact: true })
    .click()
  await expect(
    page.getByText('Not synchronized', { exact: true }),
  ).toBeVisible()
  const wrong = await request(
    page,
    `/api/v1/clients/${clientID}/websites/${secondID}/analytics/${connectionID}?since=2026-10-01&until=2026-10-03`,
    undefined,
    'GET',
  )
  expect(wrong.status()).toBe(404)
  expect(
    database(
      `SELECT count(*) FROM app.audit_events WHERE resource_kind='website' AND client_id='${clientID}'`,
    ),
  ).toBe('7')
  expect(
    database(
      `SELECT count(*) FROM app.audit_events WHERE resource_kind='website_integration' AND client_id='${clientID}'`,
    ),
  ).toBe('1')
})
test('account language selection persists across reloads and preserves entered website names', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await login(page, `/app/clients/${clientID}/websites/${firstID}`)
  const headings: Record<string, string> = {
    tr: 'Görünüm',
    ro: 'Aspect',
    de: 'Darstellung',
    fr: 'Apparence',
    en: 'Appearance',
  }
  for (const locale of ['tr', 'ro', 'de', 'fr', 'en']) {
    await page.locator('.account-trigger').click()
    // Values remain stable identifiers while visible option labels use native names.
    const language = page
      .locator('select')
      .filter({ has: page.locator('option[value="tr"]') })
    await language.selectOption(locale)
    await expect
      .poll(() =>
        database(
          `SELECT locale FROM app.user_locale_preferences WHERE user_id='${actor}'`,
        ),
      )
      .toBe(locale)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await expect(
      page.getByRole('heading', { name: 'Clients', exact: true }),
    ).toBeVisible()
    await page.locator('.account-trigger').click()
    await expect(
      page.getByRole('combobox', { name: headings[locale]!, exact: true }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
  }
})
test('website archive preserves reports, hides mutations and records safe history', async ({
  page,
}) => {
  await login(page, `/app/clients/${clientID}/websites/${firstID}`)
  await page
    .getByRole('button', { name: 'Archive website', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: 'Archive website' })
    .getByRole('button', { name: 'Confirm', exact: true })
    .click()
  await expect(
    page.getByText('Website archived.', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Edit website', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('link', { name: 'Open reports', exact: true }).click()
  await page.getByLabel('Start date', { exact: true }).fill('2026-10-01')
  await page.getByLabel('End date', { exact: true }).fill('2026-10-03')
  await page
    .getByRole('button', { name: 'Load stored reports', exact: true })
    .click()
  await expect(
    page.getByText('Not synchronized', { exact: true }),
  ).toBeVisible()
  const write = await request(
    page,
    `/api/v1/clients/${clientID}/websites/${firstID}/integrations/${connectionID}/ga4/sync`,
    { revision: '1', since: '2026-10-01', until: '2026-10-03' },
  )
  expect(write.status()).toBe(404)
  await page.goto(`/app/clients/${clientID}/websites/${firstID}/activity`)
  await expect(
    page.getByText('Website archived.', { exact: true }),
  ).toBeVisible()
  expect(
    database(
      `SELECT count(*) FROM app.analytics_sync_jobs WHERE connection_id='${connectionID}'`,
    ),
  ).toBe('0')
})
