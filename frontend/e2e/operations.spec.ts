import { completeEmailSignIn } from './otp'
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { database } from './database'

const brand = 'b0111111-1111-4111-8111-111111111111'
const employee = 'b0222222-2222-4222-8222-222222222222'
const unrelated = 'b0333333-3333-4333-8333-333333333333'
// Isolate this suite's identity so the full browser run preserves the real
// five-attempt login limiter instead of exhausting another suite's owner.
test.beforeAll(() => {
  const owner = 'a0444444-4444-4444-8444-444444444444'
  database(
    `INSERT OR IGNORE INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT '${owner}','operations.owner.fixture@example.com','Synthetic operations owner',password_hash,'active',utc_now(),utc_now() FROM users WHERE id='44444444-4444-4444-8444-444444444444'; INSERT OR IGNORE INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES('a0555555-5555-4555-8555-555555555555','${owner}','00000000-0000-4000-8000-000000000001','global',NULL,utc_now());`,
  )
})
async function login(page: Page, email: string, path = '/app') {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await completeEmailSignIn(page)
  await expect(
    page.getByRole('navigation', { name: 'Application', exact: true }),
  ).toBeVisible()
}
async function api(page: Page, path: string, body?: unknown) {
  const token = await page.evaluate(
    () =>
      document.cookie
        .split('; ')
        .find((v) => v.startsWith('else_csrf='))
        ?.slice(10) ?? '',
  )
  return page.request.fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': token },
    ...(body ? { data: body } : {}),
  })
}
async function decision(page: Page, name: string, reason?: string) {
  await page.getByRole('button', { name, exact: true }).click()
  const drawer = page.getByRole('dialog', { name, exact: true })
  if (reason) await drawer.getByLabel('Explanation').fill(reason)
  await drawer.getByRole('button', { name, exact: true }).click()
  await expect(drawer).toHaveCount(0)
}

test('operations: commercial payment, revenue share, internal transfer and audited partial refund', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120000)
  const client = 'd0111111-1111-4111-8111-111111111111'
  database(
    `INSERT INTO client_scopes(id) VALUES('${client}'); INSERT INTO clients(id,name,created_at,updated_at) VALUES('${client}','Synthetic commercial brand',utc_now(),utc_now());`,
  )
  await login(
    page,
    'operations.owner.fixture@example.com',
    `/app/clients/${client}/finance`,
  )
  await expect(
    page.getByRole('button', { name: 'New service agreement', exact: true }),
  ).toBeVisible()
  const modules = page.getByRole('navigation', {
    name: 'Client modules',
    exact: true,
  })
  const more = modules.getByRole('button', { name: 'More', exact: true })
  const profile = modules.getByRole('link', { name: 'Profile', exact: true })
  for (const theme of ['light', 'dark']) {
    await page.getByLabel('Account', { exact: true }).click()
    await page.getByLabel('Appearance', { exact: true }).selectOption(theme)
    await page.keyboard.press('Escape')
    for (const width of [1440, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 1000 })
      const ledger = page.getByRole('region', {
        name: 'Billing periods',
        exact: true,
      })
      if (width < 640) {
        await ledger.focus()
        await page.keyboard.press('ArrowRight')
        await expect
          .poll(() => ledger.evaluate((region) => region.scrollLeft))
          .toBeGreaterThan(0)
        await ledger.evaluate((region) => {
          region.scrollLeft = 0
        })
      }
      await more.focus()
      await page.keyboard.press('Enter')
      await expect(more).toHaveAttribute('aria-expanded', 'true')
      await expect(profile).toBeVisible()
      // Visibility alone misses descendants clipped by a scrolling tab bar.
      expect(
        await profile.evaluate((link) => {
          const box = link.getBoundingClientRect()
          return link.contains(
            document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            ),
          )
        }),
      ).toBe(true)
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth ===
            document.documentElement.clientWidth,
        ),
      ).toBe(true)
      await page.screenshot({
        path: info.outputPath(`client-more-${theme}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      })
      await profile.focus()
      await page.keyboard.press('Escape')
      await expect(more).toBeFocused()
      await expect(more).toHaveAttribute('aria-expanded', 'false')
      await expect(profile).toHaveCount(0)
    }
  }
  // Follow an advanced destination with an actual click on mobile.
  await more.click()
  await profile.click()
  await expect(page).toHaveURL(new RegExp(`/clients/${client}/profile$`))
  await expect(
    modules.getByRole('link', { name: 'Profile', exact: true }),
  ).toHaveAttribute('aria-current', 'page')
  await modules.getByRole('link', { name: 'Finance', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/clients/${client}/finance$`))
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page
    .getByRole('button', { name: 'Add advertising partner', exact: true })
    .click()
  let drawer = page.getByRole('dialog', {
    name: 'Add advertising partner',
    exact: true,
  })
  await drawer.getByLabel('Partner name').fill('Synthetic commercial partner')
  await drawer.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await page
    .getByRole('button', { name: 'New service agreement', exact: true })
    .click()
  drawer = page.getByRole('dialog', {
    name: 'New service agreement',
    exact: true,
  })
  await drawer.getByLabel('Service title').fill('Synthetic monthly consulting')
  await drawer.getByLabel('Service type').selectOption('advertising_consulting')
  await drawer.getByLabel('Amount', { exact: true }).fill('700')
  await drawer.getByLabel('Currency', { exact: true }).selectOption('EUR')
  await drawer
    .getByLabel('Start date', { exact: true })
    .fill(
      new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Bucharest' }).format(
        new Date(),
      ),
    )
  await drawer
    .getByLabel('Advertising partner', { exact: true })
    .selectOption({ label: 'Synthetic commercial partner' })
  await drawer.getByLabel('Roisey share included in total').fill('200')
  await drawer.getByLabel('Collector', { exact: true }).selectOption('partner')
  await drawer.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Agreement details', exact: true })
    .click()
  drawer = page.getByRole('dialog', {
    name: 'Synthetic monthly consulting',
    exact: true,
  })
  await expect(
    drawer.getByText('Synthetic commercial partner', { exact: false }),
  ).toBeVisible()
  await drawer
    .getByRole('button', { name: 'Generate due period', exact: true })
    .click()
  await expect(drawer).toHaveCount(0)
  await page
    .getByRole('link', { name: 'Synthetic monthly consulting', exact: true })
    .click()
  await expect(page).toHaveURL(/\/finance\/[a-f0-9-]{36}$/)
  const periodURL = page.url(),
    pid = periodURL.split('/').at(-1)!
  await page
    .getByRole('button', { name: 'Record customer payment', exact: true })
    .click()
  drawer = page.getByRole('dialog', {
    name: 'Record customer payment',
    exact: true,
  })
  await drawer.getByLabel('Amount', { exact: true }).fill('700')
  await drawer
    .getByLabel('Actual collector', { exact: true })
    .selectOption('partner')
  await drawer.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  let p = (
    await (
      await api(page, `/api/v1/clients/${client}/commercial-periods/${pid}`)
    ).json()
  ).data
  expect(p.outstanding_minor).toBe('0')
  expect(p.internal_remaining_to_roise_minor).toBe('20000')
  await page
    .getByRole('button', { name: 'Record internal transfer', exact: true })
    .click()
  drawer = page.getByRole('dialog', {
    name: 'Record internal transfer',
    exact: true,
  })
  await drawer.getByLabel('Amount', { exact: true }).fill('200')
  await drawer.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await page.getByRole('button', { name: 'Record refund', exact: true }).click()
  drawer = page.getByRole('dialog', { name: 'Record refund', exact: true })
  await drawer.getByLabel('Amount', { exact: true }).fill('350')
  await drawer.getByLabel('Original payment').selectOption({ index: 1 })
  await drawer
    .getByLabel('Refund reason')
    .fill('Synthetic approved partial refund')
  await drawer.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  p = (
    await (
      await api(page, `/api/v1/clients/${client}/commercial-periods/${pid}`)
    ).json()
  ).data
  expect(p.amount_minor).toBe('70000')
  expect(p.paid_minor).toBe('35000')
  expect(p.outstanding_minor).toBe('35000')
  expect(p.internal_remaining_to_roise_minor).toBe('-10000')
  expect(
    database(
      `SELECT count(*) FROM payments WHERE collection_id='${p.collection_id}'`,
    ),
  ).toBe('1')
  expect(
    database(
      `SELECT count(*) FROM payment_reversals WHERE collection_id='${p.collection_id}'`,
    ),
  ).toBe('1')
  expect(
    database(
      `SELECT count(*) FROM internal_settlements WHERE period_id='${pid}'`,
    ),
  ).toBe('1')
  const detailPath = new URL(page.url()).pathname
  await page.goto(`/app/clients/${client}/finance`)
  await expect(
    page.getByRole('heading', { name: 'Service finance', exact: true }),
  ).toBeVisible()
  await page.getByText('Period filters', { exact: true }).click()
  await page
    .getByLabel('Find service', { exact: true })
    .fill('monthly consulting')
  await page.getByLabel('Currency', { exact: true }).selectOption('EUR')
  await page
    .getByLabel('Contract collector', { exact: true })
    .selectOption('partner')
  await page
    .getByLabel('Actual payment collector', { exact: true })
    .selectOption('partner')
  await page
    .getByLabel('Payment status', { exact: true })
    .selectOption('partially_paid')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  const report = page.getByRole('table', {
    name: 'Billing periods',
    exact: true,
  })
  await expect(report.locator('tbody tr')).toHaveCount(1)
  await expect(report).toContainText('Synthetic monthly consulting')
  await expect(report).toContainText('EUR 350.00')
  await page.getByLabel('Currency', { exact: true }).selectOption('USD')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(
    page.getByText('No billing periods match these filters.', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(report.locator('tbody tr')).toHaveCount(1)
  await page.goto(detailPath)
  await expect(
    page.getByRole('heading', {
      name: 'Synthetic monthly consulting',
      exact: true,
    }),
  ).toBeVisible()
  for (const width of [360, 390, 430, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({
    path: info.outputPath('operations-finance-1440.png'),
    fullPage: true,
  })
  const employeeID = 'd0222222-2222-4222-8222-222222222222'
  database(
    `INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT '${employeeID}','commercial.employee@example.com','Synthetic finance-restricted employee',password_hash,'active',utc_now(),utc_now() FROM users WHERE id='44444444-4444-4444-8444-444444444444'; INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES(new_id(),'${employeeID}','00000000-0000-4000-8000-000000000006','client','${client}',utc_now());`,
  )
  const context = await browser.newContext(),
    staff = await context.newPage()
  await login(staff, 'commercial.employee@example.com')
  expect(
    (
      await api(staff, `/api/v1/clients/${client}/commercial-periods/${pid}`)
    ).status(),
  ).toBe(404)
  expect(
    (await api(staff, `/api/v1/clients/${client}/agreements`)).status(),
  ).toBe(404)
  expect(
    (
      await api(
        staff,
        `/api/v1/clients/${client}/billing/${p.collection_id}/reversals`,
      )
    ).status(),
  ).toBe(404)
  await context.close()
})

test('operations: website-linked screenshot request, independent review, revision and scoped evidence', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120_000)
  database(
    `INSERT INTO client_scopes(id) VALUES('${brand}'); INSERT INTO clients(id,name,created_at,updated_at) VALUES('${brand}','Synthetic operations brand',utc_now(),utc_now());`,
  )
  for (const [id, email, name] of [
    [
      employee,
      'operations.employee@example.com',
      'Synthetic advertising employee',
    ],
    [
      unrelated,
      'operations.unrelated@example.com',
      'Unrelated advertising employee',
    ],
  ]) {
    database(
      `INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT '${id}','${email}','${name}',password_hash,'active',utc_now(),utc_now() FROM users WHERE id='44444444-4444-4444-8444-444444444444'; INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES(new_id(),'${id}','00000000-0000-4000-8000-000000000006','client','${brand}',utc_now());`,
    )
  }
  await login(page, 'operations.owner.fixture@example.com')
  for (let i = 1; i <= 5; i++) {
    const response = await api(page, `/api/v1/clients/${brand}/websites`, {
      name: `Synthetic website ${i}`,
      url: `https://site${i}.example.com`,
    })
    expect(response.status()).toBe(201)
  }
  const context = await browser.newContext()
  const staff = await context.newPage()
  await login(staff, 'operations.employee@example.com')
  await expect(
    staff.getByRole('heading', { name: 'Today', exact: true }),
  ).toBeVisible()
  expect(
    (await (await api(staff, '/api/v1/today')).json()).data,
  ).not.toHaveProperty('finance')
  expect(
    (
      await api(staff, '/api/v1/clients/22222222-2222-4222-8222-222222222222')
    ).status(),
  ).toBe(404)
  await staff
    .getByRole('link', { name: 'New technical request', exact: true })
    .click()
  await staff.getByLabel('Brand', { exact: true }).selectOption(brand)
  await expect(
    staff.getByLabel('Website or brand-wide work').locator('option'),
  ).toHaveCount(7)
  await staff
    .getByLabel('Website or brand-wide work')
    .selectOption({ label: 'Synthetic website 3 · site3.example.com' })
  await staff
    .getByLabel('Request title')
    .fill('Synthetic mobile purchase button')
  await staff
    .getByLabel('What needs to change?')
    .fill('The mobile purchase button is hidden. Make it accessible.')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6MDAAAAAASUVORK5CYII=',
    'base64',
  )
  await staff.getByLabel('Choose files').setInputFiles({
    name: 'synthetic-before.png',
    mimeType: 'image/png',
    buffer: png,
  })
  await expect(staff.getByText('Uploaded', { exact: false })).toBeVisible()
  for (const width of [360, 390, 430, 1440]) {
    await staff.setViewportSize({ width, height: 1000 })
    expect(
      await staff.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  await staff
    .getByRole('button', { name: 'Submit request', exact: true })
    .click()
  await expect(
    staff.getByRole('heading', {
      name: 'Synthetic mobile purchase button',
      exact: true,
    }),
  ).toBeVisible()
  const requestURL = staff.url()
  const requestID = requestURL.split('/').at(-1)!
  await page.goto(requestURL)
  expect(
    (
      await api(page, `/api/v1/clients/${brand}/requests/${requestID}/reject`, {
        command_id: crypto.randomUUID(),
        expected_revision: '1',
        reason: '',
      })
    ).status(),
  ).toBe(400)
  await decision(page, 'Accept request')
  await decision(page, 'Start work')
  async function deliver(notes: string, file: string) {
    await page
      .getByRole('button', { name: 'Submit delivery', exact: true })
      .click()
    const drawer = page.getByRole('dialog', {
      name: 'Submit delivery',
      exact: true,
    })
    await drawer.getByLabel('Completion summary').fill(notes)
    await drawer
      .getByLabel('Choose files')
      .setInputFiles({ name: file, mimeType: 'image/png', buffer: png })
    await expect(drawer.getByText('Uploaded', { exact: false })).toBeVisible()
    await drawer
      .getByRole('button', { name: 'Submit delivery', exact: true })
      .click()
    await expect(drawer).toHaveCount(0)
  }
  await deliver(
    'Mobile layout updated. Please review.',
    'synthetic-after-1.png',
  )
  await expect(
    page.getByRole('button', { name: 'Approve delivery', exact: true }),
  ).toHaveCount(0)
  const pendingReview = (
    await (
      await api(page, `/api/v1/clients/${brand}/requests/${requestID}`)
    ).json()
  ).data
  const reviewCommand = {
    command_id: crypto.randomUUID(),
    expected_revision: pendingReview.revision,
    reason: '',
    delivery_id: pendingReview.deliveries[0].id,
  }
  expect(
    (
      await api(
        page,
        `/api/v1/clients/${brand}/requests/${requestID}/approve`,
        reviewCommand,
      )
    ).status(),
  ).toBe(403)
  expect(
    (
      await api(
        staff,
        `/api/v1/clients/${brand}/requests/${requestID}/revise`,
        { ...reviewCommand, command_id: crypto.randomUUID() },
      )
    ).status(),
  ).toBe(400)
  await staff.reload()
  await expect(
    staff.getByRole('button', { name: 'Request revision', exact: true }),
  ).toBeVisible()
  await decision(
    staff,
    'Request revision',
    'The iPhone layout still needs spacing.',
  )
  await page.reload()
  await decision(page, 'Start work')
  await deliver(
    'Second delivery: iPhone spacing corrected.',
    'synthetic-after-2.png',
  )
  await staff.reload()
  await decision(staff, 'Approve delivery')
  await expect(
    staff.getByRole('heading', {
      name: 'Synthetic mobile purchase button',
      exact: true,
    }),
  ).toBeVisible()
  const detail = (
    await (
      await api(staff, `/api/v1/clients/${brand}/requests/${requestID}`)
    ).json()
  ).data
  expect(detail.status).toBe('approved')
  expect(detail.deliveries).toHaveLength(2)
  expect(detail.reviews).toHaveLength(2)
  expect(detail.evidence).toHaveLength(3)
  for (const theme of ['light', 'dark']) {
    await staff
      .getByRole('banner')
      .getByText('Synthetic advertising employee', { exact: true })
      .click()
    await staff
      .getByRole('combobox', { name: 'Appearance' })
      .selectOption(theme)
    await staff
      .getByRole('banner')
      .getByText('Synthetic advertising employee', { exact: true })
      .click()
    for (const width of [390, 1440]) {
      await staff.setViewportSize({ width, height: 1000 })
      expect(
        await staff.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      await staff.screenshot({
        path: info.outputPath(`operations-${theme}-${width}.png`),
        fullPage: true,
      })
    }
  }
  const strangerContext = await browser.newContext()
  const stranger = await strangerContext.newPage()
  await login(stranger, 'operations.unrelated@example.com')
  expect(
    (
      await api(stranger, `/api/v1/clients/${brand}/requests/${requestID}`)
    ).status(),
  ).toBe(404)
  expect(
    (
      await api(
        stranger,
        `/api/v1/clients/${brand}/evidence/${detail.evidence[0].id}`,
      )
    ).status(),
  ).toBe(404)
  const inbox = (
    await (await api(staff, '/api/v1/notifications?limit=25')).json()
  ).data
  expect(inbox.length).toBeGreaterThan(0)
  const foreignRead = await api(
    stranger,
    `/api/v1/notifications/${inbox[0].id}/read`,
    {},
  )
  expect(foreignRead.status()).toBe(404)
  expect(
    database(
      `SELECT count(*) FROM request_events WHERE request_id='${requestID}'`,
    ),
  ).toBe('8')
  await strangerContext.close()
  await context.close()
})

test('operations: team leader scope, brand assignment and dynamic removal', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000)
  const teamBrand = 'c0111111-1111-4111-8111-111111111111',
    leaderID = 'c0222222-2222-4222-8222-222222222222',
    memberID = 'c0333333-3333-4333-8333-333333333333'
  database(
    `INSERT INTO client_scopes(id) VALUES('${teamBrand}'); INSERT INTO clients(id,name,created_at,updated_at) VALUES('${teamBrand}','Synthetic team brand',utc_now(),utc_now());`,
  )
  for (const [id, email, name] of [
    [leaderID, 'team.leader@example.com', 'Synthetic team leader'],
    [memberID, 'team.member@example.com', 'Synthetic assigned employee'],
  ])
    database(
      `INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT '${id}','${email}','${name}',password_hash,'active',utc_now(),utc_now() FROM users WHERE id='44444444-4444-4444-8444-444444444444';`,
    )
  await login(page, 'operations.owner.fixture@example.com', '/app/team')
  await page.getByRole('button', { name: 'Create team', exact: true }).click()
  let drawer = page.getByRole('dialog', { name: 'Create team', exact: true })
  await drawer.getByLabel('Team name').fill('Synthetic advertising team')
  await drawer.getByLabel('Team leader').selectOption(leaderID)
  await drawer.getByRole('button', { name: 'Create team', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await page
    .getByRole('link', { name: 'Synthetic advertising team', exact: true })
    .click()
  await expect(page).toHaveURL(/\/team\/[a-f0-9-]{36}$/)
  const url = page.url()
  await page.getByRole('button', { name: 'Add employee', exact: true }).click()
  drawer = page.getByRole('dialog', { name: 'Add employee', exact: true })
  await drawer.getByLabel('Employee', { exact: true }).selectOption(memberID)
  await drawer
    .getByRole('button', { name: 'Add employee', exact: true })
    .click()
  await expect(drawer).toHaveCount(0)
  async function assign(user: string) {
    await page
      .getByRole('button', { name: 'Assign brand', exact: true })
      .click()
    const form = page.getByRole('dialog', { name: 'Assign brand', exact: true })
    await form.getByLabel('Employee', { exact: true }).selectOption(user)
    await form
      .getByLabel('Find brand', { exact: true })
      .fill('Synthetic team brand')
    await form.getByLabel('Brand', { exact: true }).selectOption(teamBrand)
    await form
      .getByLabel('Responsibility')
      .fill('Synthetic campaign operations')
    await form
      .getByRole('button', { name: 'Assign brand', exact: true })
      .click()
    await expect(form).toHaveCount(0)
  }
  await assign(leaderID)
  const leadContext = await browser.newContext(),
    lead = await leadContext.newPage()
  await login(lead, 'team.leader@example.com', new URL(url).pathname)
  await expect(
    lead.getByRole('navigation', { name: 'Breadcrumb', exact: true }),
  ).toContainText('Team')
  await lead.getByRole('button', { name: 'Assign brand', exact: true }).click()
  drawer = lead.getByRole('dialog', { name: 'Assign brand', exact: true })
  await drawer.getByLabel('Employee', { exact: true }).selectOption(memberID)
  await drawer
    .getByLabel('Find brand', { exact: true })
    .fill('Synthetic team brand')
  await drawer.getByLabel('Brand', { exact: true }).selectOption(teamBrand)
  await drawer.getByLabel('Responsibility').fill('Synthetic campaign tracking')
  await drawer
    .getByRole('button', { name: 'Assign brand', exact: true })
    .click()
  await expect(drawer).toHaveCount(0)
  expect(
    (await (await api(lead, '/api/v1/today')).json()).data,
  ).not.toHaveProperty('finance')
  expect(
    (await api(lead, `/api/v1/clients/${teamBrand}/billing`)).status(),
  ).toBe(404)
  const memberContext = await browser.newContext(),
    member = await memberContext.newPage()
  await login(member, 'team.member@example.com')
  await expect(
    member.getByRole('link', { name: /Synthetic team brand/ }),
  ).toBeVisible()
  expect((await api(member, `/api/v1/clients/${teamBrand}`)).status()).toBe(200)
  expect(
    (
      await api(member, '/api/v1/clients/22222222-2222-4222-8222-222222222222')
    ).status(),
  ).toBe(404)
  expect((await api(member, '/api/v1/teams')).status()).toBe(403)
  for (const width of [360, 390, 430, 1440]) {
    await lead.setViewportSize({ width, height: 1000 })
    expect(
      await lead.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    if (width === 1440)
      await lead.screenshot({
        path: info.outputPath('operations-team-1440.png'),
        fullPage: true,
      })
  }
  const row = lead
    .getByRole('listitem')
    .filter({ hasText: 'Synthetic assigned employee' })
    .filter({ hasText: 'Synthetic team brand' })
  lead.once('dialog', (dialog) => dialog.accept())
  await row
    .getByRole('button', { name: 'Remove assignment', exact: true })
    .click()
  await expect(row).toHaveCount(0)
  expect((await api(member, `/api/v1/clients/${teamBrand}`)).status()).toBe(404)
  await member.reload()
  await expect(
    member.getByRole('link', { name: /Synthetic team brand/ }),
  ).toHaveCount(0)
  expect(
    database(
      `SELECT count(*) FROM brand_staff_assignments WHERE user_id='${memberID}' AND revoked_at IS NOT NULL`,
    ),
  ).toBe('1')
  await leadContext.close()
  await memberContext.close()
})

test('operations: real recurring worker, monthly maintenance, personal preferences and employee isolation', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(150000)
  const client = 'e0111111-1111-4111-8111-111111111111',
    person = 'e0222222-2222-4222-8222-222222222222'
  database(
    `INSERT INTO client_scopes(id) VALUES('${client}'); INSERT INTO clients(id,name,created_at,updated_at) VALUES('${client}','Synthetic recurring brand',utc_now(),utc_now()); INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT '${person}','recurring.person@example.com','Synthetic recurring employee',password_hash,'active',utc_now(),utc_now() FROM users WHERE id='44444444-4444-4444-8444-444444444444'; INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES('e0333333-3333-4333-8333-333333333333','${person}','00000000-0000-4000-8000-000000000006','client','${client}',utc_now());`,
  )
  await login(
    page,
    'operations.owner.fixture@example.com',
    `/app/clients/${client}/recurring-tasks`,
  )
  await page
    .getByRole('button', { name: 'New recurring task', exact: true })
    .click()
  let form = page.getByRole('dialog', {
    name: 'New recurring task',
    exact: true,
  })
  await form
    .getByLabel('Task title', { exact: true })
    .fill('Synthetic daily campaign check')
  await form.getByLabel('Assignee', { exact: true }).selectOption(person)
  await form.getByLabel('Frequency', { exact: true }).selectOption('daily')
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Bucharest',
  }).format(new Date())
  await form.getByLabel('Start date', { exact: true }).fill(local)
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/recurring-tasks/[a-f0-9-]+$`))
  const id = page.url().split('/').at(-1)!
  await expect
    .poll(
      async () =>
        (
          await (
            await api(
              page,
              `/api/v1/clients/${client}/recurring-tasks/${id}/occurrences`,
            )
          ).json()
        ).data.length,
      { timeout: 45000 },
    )
    .toBe(1)
  const occurrences = (
    await (
      await api(
        page,
        `/api/v1/clients/${client}/recurring-tasks/${id}/occurrences`,
      )
    ).json()
  ).data
  expect(
    (
      await (
        await api(
          page,
          `/api/v1/clients/${client}/recurring-tasks/${id}/generate`,
          { scheduled_date: local },
        )
      ).json()
    ).data.replayed,
  ).toBe(true)
  expect(
    database(
      `SELECT count(*) FROM recurring_task_occurrences WHERE template_id='${id}'`,
    ),
  ).toBe('1')
  expect(
    Number(
      database(
        `SELECT count(*) FROM audit_events WHERE resource_id='${id}' AND json_extract(metadata,'$.source')='job'`,
      ),
    ),
  ).toBeGreaterThan(0)
  await page.reload()
  await page
    .getByRole('button', { name: 'Pause schedule', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Resume schedule', exact: true }),
  ).toBeVisible()
  await page.getByText('Schedule history', { exact: true }).click()
  await expect(page.getByText(/Version 1/)).toBeVisible()
  await page.goto(`/app/clients/${client}/finance`)
  await page
    .getByRole('button', { name: 'New service agreement', exact: true })
    .click()
  form = page.getByRole('dialog', {
    name: 'New service agreement',
    exact: true,
  })
  await form
    .getByLabel('Service title')
    .fill('Synthetic monthly software maintenance')
  await form.getByLabel('Amount', { exact: true }).fill('1000')
  await form.getByLabel('Currency', { exact: true }).selectOption('USD')
  await form.getByLabel('Start date', { exact: true }).fill(local)
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect
    .poll(
      async () =>
        (
          await (
            await api(page, `/api/v1/clients/${client}/commercial-periods`)
          ).json()
        ).data.length,
      { timeout: 45000 },
    )
    .toBe(1)
  const period = (
    await (
      await api(page, `/api/v1/clients/${client}/commercial-periods`)
    ).json()
  ).data[0]
  expect(period.amount_minor).toBe('100000')
  expect(period.currency).toBe('USD')
  expect(period.roise_share_minor).toBe('100000')
  expect(period.partner_share_minor).toBe('0')
  expect(
    (
      await (
        await api(
          page,
          `/api/v1/clients/${client}/agreements/${period.agreement_id}/generate`,
          { billing_date: local },
        )
      ).json()
    ).data.replayed,
  ).toBe(true)
  expect(
    database(
      `SELECT count(*) FROM billing_periods WHERE agreement_id='${period.agreement_id}'`,
    ),
  ).toBe('1')
  await page.goto(`/app/clients/${client}/finance/${period.id}`)
  await page
    .getByRole('button', { name: 'Record customer payment', exact: true })
    .click()
  form = page.getByRole('dialog', {
    name: 'Record customer payment',
    exact: true,
  })
  await form.getByLabel('Amount', { exact: true }).fill('600')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(form).toHaveCount(0)
  expect(
    (
      await (
        await api(
          page,
          `/api/v1/clients/${client}/commercial-periods/${period.id}`,
        )
      ).json()
    ).data.outstanding_minor,
  ).toBe('40000')
  const context = await browser.newContext(),
    member = await context.newPage()
  await login(member, 'recurring.person@example.com')
  await expect(
    member.getByRole('link', {
      name: /^Synthetic daily campaign check/,
    }),
  ).toBeVisible()
  expect(
    (await (await api(member, '/api/v1/today')).json()).data,
  ).not.toHaveProperty('finance')
  expect(
    (
      await api(member, `/api/v1/clients/${client}/recurring-tasks/${id}`)
    ).status(),
  ).toBe(404)
  expect(
    (
      await api(
        member,
        `/api/v1/clients/${client}/commercial-periods/${period.id}`,
      )
    ).status(),
  ).toBe(404)
  expect(
    (
      await api(
        member,
        `/api/v1/clients/${client}/tasks/${occurrences[0].task_id}`,
      )
    ).status(),
  ).toBe(200)
  const dossier = (
    await (await api(member, `/api/v1/clients/${client}/overview`)).json()
  ).data
  expect(dossier).not.toHaveProperty('finance')
  expect(dossier).toHaveProperty('operations')
  expect(
    [...dossier.tasks.overdue.items, ...dossier.tasks.due_soon.items].some(
      (v) => v.title === 'Synthetic daily campaign check',
    ),
  ).toBe(true)
  await member.goto('/app/tasks')
  await expect(
    member.getByRole('link', {
      name: 'Synthetic daily campaign check',
      exact: true,
    }),
  ).toBeVisible()
  await member.goto('/app/settings')
  await expect(member.getByRole('tab')).toHaveText([
    'Workspace',
    'Notifications',
    'AI connections',
  ])
  await expect(
    member.getByRole('tab', { name: 'Organization', exact: true }),
  ).toHaveCount(0)
  await member.getByRole('tab', { name: 'Notifications', exact: true }).click()
  await member
    .getByRole('checkbox', {
      name: 'Task deadlines and recurrence',
      exact: true,
    })
    .uncheck()
  await member.getByRole('tab', { name: 'Workspace', exact: true }).click()
  await member.getByRole('tab', { name: 'Notifications', exact: true }).click()
  await expect(
    member.getByRole('checkbox', {
      name: 'Task deadlines and recurrence',
      exact: true,
    }),
  ).not.toBeChecked()
  await member.getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await (await api(member, '/api/v1/preferences')).json()).data.tasks,
    )
    .toBe(false)
  await member.reload()
  await member.getByRole('tab', { name: 'Notifications', exact: true }).click()
  await expect(
    member.getByRole('checkbox', {
      name: 'Task deadlines and recurrence',
      exact: true,
    }),
  ).not.toBeChecked()
  await expect(
    member.getByRole('button', { name: 'Save', exact: true }),
  ).toBeEnabled()
  await member.getByRole('tab', { name: 'Workspace', exact: true }).click()
  for (const theme of ['light', 'dark']) {
    await member
      .getByRole('radio', {
        name: theme === 'dark' ? 'Dark' : 'Light',
        exact: true,
      })
      .check()
    await expect(member.locator('html')).toHaveClass(
      theme === 'dark' ? /dark/ : /^$/,
    )
    await member.waitForFunction(() => {
      const button = document.querySelector('main button[type=submit]')
      return (
        button &&
        getComputedStyle(button).color === getComputedStyle(document.body).color
      )
    })
    for (const width of [360, 390, 430, 1440, 1920]) {
      await member.setViewportSize({ width, height: 1000 })
      await member.evaluate(() => scrollTo(0, 0))
      expect(
        await member.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      if (width === 390 || width === 1440)
        await member.screenshot({
          path: info.outputPath(`operations-settings-${theme}-${width}.png`),
          fullPage: true,
        })
    }
  }
  await context.close()
})
