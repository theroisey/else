import { test, expect, type Page } from '@playwright/test'
import { database } from './database'
const client = 'f9111111-1111-4111-8111-111111111111',
  owner = 'f9222222-2222-4222-8222-222222222222'
const today = () => new Date().toISOString().slice(0, 10)
test.beforeAll(() =>
  database(
    `INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT '${owner}','financial.owner.fixture@example.com','Synthetic financial owner',password_hash,'active',utc_now(),utc_now() FROM users WHERE id='44444444-4444-4444-8444-444444444444'; INSERT INTO user_roles(id,user_id,role_id,scope_kind,assigned_at) VALUES('f9333333-3333-4333-8333-333333333333','${owner}','00000000-0000-4000-8000-000000000001','global',utc_now()); INSERT INTO client_scopes(id) VALUES('${client}'); INSERT INTO clients(id,name,created_at,updated_at) VALUES('${client}','Synthetic financial dashboard brand',utc_now(),utc_now());`,
  ),
)
async function login(page: Page) {
  await page.goto('/app/finance/dashboard')
  await page
    .getByLabel('Email', { exact: true })
    .fill('financial.owner.fixture@example.com')
  await page
    .getByLabel('Password', { exact: true })
    .fill('clearly synthetic browser password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Financial Dashboard', exact: true }),
  ).toBeVisible()
}
async function api(page: Page, path: string, body?: unknown) {
  const csrf = await page.evaluate(
    () =>
      document.cookie
        .split('; ')
        .find((v) => v.startsWith('else_csrf='))
        ?.slice(10) ?? '',
  )
  return page.request.fetch('/api/v1/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrf },
    ...(body ? { data: body } : {}),
  })
}
test('financial intelligence: exact reporting, expense corrections, exports, mobile themes and real permission denial', async ({
  page,
}, info) => {
  test.setTimeout(150000)
  await login(page)
  const create = await api(page, `clients/${client}/billing`, {
    description: 'Synthetic EUR obligation',
    amount_minor: '70000',
    currency: 'EUR',
    due_date: '2000-01-01',
  })
  expect(create.ok()).toBeTruthy()
  const charge = (await create.json()).data
  const pay = await api(
    page,
    `clients/${client}/billing/${charge.id}/payments`,
    {
      command_id: crypto.randomUUID(),
      expected_revision: '1',
      amount_minor: '35000',
      currency: 'EUR',
      paid_on: today(),
      method: 'bank_transfer',
    },
  )
  expect(pay.ok()).toBeTruthy()
  const dash = await api(
    page,
    `finance/dashboard?currency=EUR&client_id=${client}`,
  )
  const dashboardResponse = await dash.json()
  expect(dash.status(), dashboardResponse.error?.code).toBe(200)
  const data = dashboardResponse.data
  for (const group of ['day', 'week', 'month', 'quarter', 'year']) {
    const response = await api(
      page,
      `finance/dashboard?currency=EUR&client_id=${client}&group=${group}`,
    )
    expect(response.status()).toBe(200)
    const report = (await response.json()).data
    expect(report.group).toBe(group)
    expect(report.position.outstanding_minor).toBe('35000')
    expect(report.trends.at(-1).cumulative_minor).toBe('35000')
  }
  expect(data.position.outstanding_minor).toBe('35000')
  expect(data.activity.unknown_minor).toBe('35000')
  expect(
    data.aging.reduce(
      (n: bigint, r: { amount_minor: string }) => n + BigInt(r.amount_minor),
      0n,
    ),
  ).toBe(35000n)
  await page.getByText('Advanced filters', { exact: true }).click()
  await page
    .getByLabel('Find a client', { exact: true })
    .fill('Synthetic financial dashboard brand')
  await page.getByLabel('Client', { exact: true }).selectOption(client)
  const filterStart = Date.now()
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(
    page.getByRole('button', { name: /Current outstanding/ }),
  ).toContainText('350.00')
  const filterRenderMs = Date.now() - filterStart
  const heap = await page.evaluate(
    () =>
      (performance as Performance & { memory?: { usedJSHeapSize: number } })
        .memory?.usedJSHeapSize ?? null,
  )
  console.log(
    JSON.stringify({
      financial_filter_render_ms: filterRenderMs,
      browser_heap_bytes: heap,
    }),
  )
  await page
    .getByRole('navigation', { name: 'Financial sections' })
    .getByRole('button', { name: 'Receivables', exact: true })
    .click()
  await expect(
    page.getByRole('region', { name: 'Receivables report', exact: true }),
  ).toContainText('Synthetic EUR obligation')
  const csv = await api(
    page,
    `finance/exports/receivables?client_id=${client}&currency=EUR`,
  )
  expect((await csv.json()).data.csv).toContain('35000')
  await page
    .getByRole('navigation', { name: 'Financial sections' })
    .getByRole('button', { name: 'Expenses', exact: true })
    .click()
  await page.getByText('Add an expense category', { exact: true }).click()
  await page
    .getByLabel('Category name', { exact: true })
    .fill('Synthetic cloud cost')
  await page.getByRole('button', { name: 'Add category', exact: true }).click()
  await expect(page.getByLabel('Category name', { exact: true })).toHaveValue(
    '',
  )
  await page
    .getByRole('button', { name: 'Record an expense', exact: true })
    .click()
  await page
    .getByLabel('Expense title', { exact: true })
    .fill('Synthetic financial hosting')
  await page
    .getByLabel('Category', { exact: true })
    .selectOption({ label: 'Synthetic cloud cost' })
  await page.getByLabel('Amount', { exact: true }).fill('100')
  await page
    .getByRole('button', { name: 'Review expense command', exact: true })
    .click()
  let dialog = page.getByRole('dialog', {
    name: 'Confirm expense command',
    exact: true,
  })
  await dialog
    .getByRole('button', { name: 'Confirm and submit', exact: true })
    .click()
  dialog = page.getByRole('dialog', {
    name: 'Expense command confirmed',
    exact: true,
  })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page
    .getByRole('button', { name: 'Synthetic financial hosting', exact: true })
    .click()
  await page.getByLabel('Amount', { exact: true }).fill('60')
  await page
    .getByRole('button', { name: 'Review expense command', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: 'Confirm expense command', exact: true })
    .getByRole('button', { name: 'Confirm and submit', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: 'Expense command confirmed', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click()
  await expect(
    page.getByRole('region', { name: 'Retained payment history', exact: true }),
  ).toContainText('60.00')
  await page
    .getByRole('button', { name: 'Reverse payment', exact: true })
    .click()
  await page.getByLabel('Amount', { exact: true }).fill('10')
  await page
    .getByLabel('Correction reason', { exact: true })
    .fill('Synthetic correction')
  await page
    .getByRole('button', { name: 'Review expense command', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: 'Confirm expense command', exact: true })
    .getByRole('button', { name: 'Confirm and submit', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: 'Expense command confirmed', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click()
  await expect(
    page.getByRole('region', { name: 'Retained payment history', exact: true }),
  ).toContainText('10.00')
  await page
    .getByRole('navigation', { name: 'Financial sections' })
    .getByRole('button', { name: 'Overview', exact: true })
    .click()
  await page.getByText('Advanced filters', { exact: true }).click()
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.classList.toggle('dark', t === 'dark')
      document.documentElement.dataset.theme = t
    }, theme)
    for (const width of [360, 390, 430, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBeTruthy()
      await expect(
        page.getByRole('heading', { name: 'Financial Dashboard', exact: true }),
      ).toBeVisible()
      await page.evaluate(() => window.scrollTo(0, 0))
      if (width === 390 || width === 1440)
        await page.screenshot({
          path: info.outputPath(`financial-${theme}-${width}.png`),
          animations: 'disabled',
          fullPage: true,
        })
    }
  }
  // Revocation is checked by actual HTTP after the already-rendered report.
  database(
    `UPDATE user_roles SET revoked_at=utc_now() WHERE user_id='${owner}';`,
  )
  const denied = await api(page, 'finance/dashboard?currency=EUR')
  expect(denied.status()).toBe(403)
  const deniedFile = await api(page, 'finance/exports/receivables?currency=EUR')
  expect(deniedFile.status()).toBe(403)
})
