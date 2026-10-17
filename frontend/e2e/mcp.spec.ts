import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { database } from './database'
const owner = 'ca444444-4444-4444-8444-444444444444'
const email = 'mcp.owner.fixture@example.com'
test.beforeAll(() => {
  database(
    `INSERT OR IGNORE INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT '${owner}','${email}','Synthetic MCP owner',password_hash,'active',utc_now(),utc_now() FROM users WHERE id='44444444-4444-4444-8444-444444444444'; INSERT OR IGNORE INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES('ca555555-5555-4555-8555-555555555555','${owner}','00000000-0000-4000-8000-000000000001','global',NULL,utc_now());`,
  )
  // The consent picker must work with more than one page of authorized brands,
  // including when this file runs independently of the portfolio regression.
  database(`INSERT OR IGNORE INTO client_scopes(id) SELECT 'cb000000-0000-4000-8000-'||printf('%012d',n) FROM (WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<26) SELECT n FROM seq); INSERT OR IGNORE INTO clients(id,name,created_at,updated_at) SELECT 'cb000000-0000-4000-8000-'||printf('%012d',n),'Synthetic consent search fixture '||n,utc_now(),utc_now() FROM (WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<26) SELECT n FROM seq);`)
})
async function login(page: Page, path: string) {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page
    .getByLabel('Password', { exact: true })
    .fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(
    page.getByRole('navigation', { name: 'Application', exact: true }),
  ).toBeVisible()
}
async function api(page: Page, path: string, body?: unknown) {
  const csrf = await page.evaluate(
    () =>
      document.cookie
        .split('; ')
        .find((v) => v.startsWith('else_csrf='))
        ?.slice('else_csrf='.length) ?? '',
  )
  const response = await page.request.fetch('/api/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: process.env.AUTH_TEST_ORIGIN!, 'X-CSRF-Token': csrf },
    ...(body === undefined ? {} : { data: body }),
  })
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}
test('MCP consent survives login, financial approval is exact, and management fits both themes and five locales', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(60_000)
  await login(page, '/app/mcp')
  await expect(
    page.getByRole('heading', { name: 'AI connections', exact: true }).first(),
  ).toBeVisible()
  const enabled = page.getByRole('button', { name: 'Enable MCP', exact: true })
  if (await enabled.isVisible()) await enabled.click()
  await expect(
    page.getByRole('button', {
      name: 'Disable MCP and revoke grants',
      exact: true,
    }),
  ).toBeVisible()
  await page
    .getByLabel('Application name', { exact: true })
    .fill('Synthetic browser MCP client')
  const origin = process.env.AUTH_TEST_ORIGIN!
  const callback = origin + '/synthetic-mcp-callback'
  await page
    .getByLabel('Exact redirect URLs, one per line', { exact: true })
    .fill(callback)
  await page
    .getByRole('button', { name: 'Register application', exact: true })
    .click()
  await expect(
    page.getByText('Synthetic browser MCP client', { exact: true }),
  ).toBeVisible()
  const applications = await page.request.get('/api/v1/mcp/applications')
  const registered = (await applications.json()).data.find(
    (a: { name: string }) => a.name === 'Synthetic browser MCP client',
  )
  expect(Boolean(registered?.id)).toBe(true)
  const client = await api(page, 'clients', {
    name: 'Synthetic MCP approval brand',
  })
  const collection = await api(page, `clients/${client.id}/billing`, {
    description: 'Synthetic consulting fee',
    amount_minor: '70000',
    currency: 'EUR',
  })
  const verifier = 'v'.repeat(64)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: registered.id,
    redirect_uri: callback,
    resource: origin + '/mcp',
    scope: 'clients:read finance:read finance:write',
    state: 'synthetic-browser-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  const authorization = await page.request.get('/oauth/authorize?' + params, {
    maxRedirects: 0,
  })
  expect(authorization.status()).toBe(302)
  const authorizationURL = authorization.headers().location!
  await context.clearCookies()
  await login(page, authorizationURL)
  await expect(
    page.getByRole('heading', { name: 'Authorize AI connection', exact: true }),
  ).toBeVisible()
  await page
    .getByLabel('Find a brand (optional)', { exact: true })
    .fill('Synthetic MCP approval brand')
  await page
    .getByLabel('Access boundary', { exact: true })
    .selectOption(client.id)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({
    path: testInfo.outputPath('mcp-consent-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  })
  let callbackURL = ''
  await page.route(callback + '**', async (route) => {
    callbackURL = route.request().url()
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'Synthetic OAuth callback received.',
    })
  })
  await page
    .getByRole('button', { name: 'Authorize connection', exact: true })
    .click()
  await expect(
    page.getByText('Synthetic OAuth callback received.', { exact: true }),
  ).toBeVisible()
  const returned = new URL(callbackURL)
  expect(returned.searchParams.get('state')).toBe('synthetic-browser-state')
  expect(returned.searchParams.get('iss')).toBe(origin)
  const exchange = await page.request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      client_id: registered.id,
      resource: origin + '/mcp',
      redirect_uri: callback,
      code: returned.searchParams.get('code')!,
      code_verifier: verifier,
    },
  })
  expect(exchange.status()).toBe(200)
  const credentials = await exchange.json()
  const tool = async (args: unknown, expected = 200) => {
    const response = await page.request.post('/mcp', {
      headers: {
        Authorization: 'Bearer ' + credentials.access_token,
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'else_collections_record_payment',
      },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'else_collections_record_payment',
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
    })
    expect(response.status()).toBe(expected)
    return response.json()
  }
  const payment = {
    client_id: client.id,
    id: collection.id,
    command_id: randomUUID(),
    input: {
      expected_revision: '1',
      amount_minor: '35000',
      currency: 'EUR',
      paid_on: '2020-01-01',
      method: 'bank_transfer',
      reference: 'Synthetic test payment',
    },
  }
  const prepared = (await tool(payment)).result.structuredContent.data
  expect(prepared.status).toBe('approval_required')
  expect(
    (await api(page, `clients/${client.id}/billing/${collection.id}`))
      .paid_minor,
  ).toBe('0')
  await page.goto(prepared.review_path)
  await expect(
    page.getByRole('heading', { name: 'Review requested change', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Approve exact change', exact: true })
    .click()
  await expect(
    page.getByText(
      'Your decision is saved. Return to your assistant to continue.',
      { exact: true },
    ),
  ).toBeVisible()
  const approved = { ...payment, approval_id: prepared.approval_id }
  const first = (await tool(approved)).result.structuredContent.data
  expect(first.status).toBe('committed')
  expect((await tool(approved)).result.structuredContent.data).toEqual(first)
  const position = await api(
    page,
    `clients/${client.id}/billing/${collection.id}`,
  )
  expect(position.paid_minor).toBe('35000')
  expect(position.outstanding_minor).toBe('35000')
  await page.goto('/app/mcp')
  await expect(
    page.getByRole('heading', { name: 'Connection activity', exact: true }),
  ).toBeVisible()
  for (const locale of ['en', 'tr', 'ro', 'de', 'fr']) {
    await page.evaluate((value) => {
      localStorage.setItem('roisey-else.locale', value)
      dispatchEvent(new StorageEvent('storage', { key: 'roisey-else.locale' }))
    }, locale)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    for (const appearance of ['light', 'dark']) {
      await page.evaluate((value) => {
        localStorage.setItem('roisey-else.appearance', value)
        dispatchEvent(
          new StorageEvent('storage', { key: 'roisey-else.appearance' }),
        )
      }, appearance)
      await expect(page.locator('html')).toHaveAttribute(
        'data-appearance',
        appearance,
      )
      for (const width of [360, 390, 430, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.evaluate(() => document.fonts.ready)
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${locale} ${appearance} ${width}`,
        ).toBe(true)
        if (locale === 'en' && [390, 1440].includes(width))
          await page.screenshot({
            path: testInfo.outputPath(
              `mcp-management-${appearance}-${width}.png`,
            ),
            fullPage: true,
            animations: 'disabled',
          })
      }
    }
  }
})
