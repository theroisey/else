// Chromium enforcement/compatibility against a built artifact and real API.
// Actual nginx header application is checked independently in Container CI.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium, expect } from '@playwright/test'

let stage = 'private origin'
let browser
let attacker
try {
  const origin = new URL(process.argv[2])
  assert.equal(origin.protocol, 'http:')
  assert.equal(origin.hostname, '127.0.0.1')
  assert.equal(origin.pathname, '/')
  assert.equal(origin.username + origin.password + origin.search + origin.hash, '')
  assert.ok(origin.port)
  let attackRequests = 0
  attacker = createServer((request, response) => {
    if (request.url === '/frame') {
      response.setHeader('Content-Type', 'text/html')
      response.end(`<iframe src="${origin.origin}/app/access"></iframe>`)
    } else {
      attackRequests += 1
      response.setHeader('Content-Type', 'application/javascript')
      response.end('window.syntheticUnsafeScriptRan = true')
    }
  })
  await new Promise((resolve, reject) => {
    attacker.once('error', reject)
    attacker.listen(0, '127.0.0.1', resolve)
  })
  const hostile = `http://127.0.0.1:${attacker.address().port}`
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
  })
  const page = await browser.newPage()
  await page.addInitScript(() => {
    window.syntheticCSPViolations = []
    window.syntheticCSPKinds = []
    document.addEventListener('securitypolicyviolation', (event) => {
      window.syntheticCSPViolations.push(event.effectiveDirective)
      window.syntheticCSPKinds.push(['eval', 'inline'].includes(event.blockedURI) ? event.blockedURI : 'source')
    })
  })
  stage = 'built sign-in rendering'
  await page.goto(`${origin.origin}/app/access`)
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  stage = 'bundled icon CSS'
  await expect(page.locator('svg.svg-inline--fa').first()).toBeVisible()
  // Flex items are blockified by layout; verify the bundled icon rule itself.
  const iconStyle = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.svg-inline--fa'))
    return { boxSizing: style.boxSizing, height: parseFloat(style.height), fontSize: parseFloat(style.fontSize), verticalAlign: parseFloat(style.verticalAlign) }
  })
  assert.equal(iconStyle.boxSizing, 'content-box')
  assert.equal(iconStyle.height, iconStyle.fontSize)
  assert.equal(iconStyle.verticalAlign, -0.125 * iconStyle.fontSize)
  stage = 'real failed-login response'
  await page.getByLabel('Email', { exact: true }).fill('csp.synthetic@example.com')
  await page.getByLabel('Password', { exact: true }).fill('clearly synthetic failed password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.')
  stage = 'real API readiness'
  assert.equal(await page.evaluate(async () => (await fetch('/ready')).status), 200)
  stage = 'legitimate UI without CSP violations'
  const legitimateViolations = await page.evaluate(() => window.syntheticCSPViolations)
  stage += ` (${legitimateViolations.filter((value) => /^[a-z-]+$/.test(value)).join(', ')})`
  stage += ` (${(await page.evaluate(() => window.syntheticCSPKinds)).join(', ')})`
  assert.deepEqual(legitimateViolations, [])

  // DevTools evaluation can bypass code-generation policy. A normal allowed
  // same-origin script must attempt eval for real browser enforcement proof.
  stage = 'eval denial from ordinary same-origin script'
  await page.evaluate(() => new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/_security-test/eval.js'
    script.onload = resolve
    script.onerror = reject
    document.head.append(script)
  }))
  assert.equal(await page.evaluate(() => window.syntheticEvalProbeLoaded), true)
  await expect.poll(() => page.evaluate(() => window.syntheticCSPViolations)).toContain('script-src')
  assert.equal(await page.evaluate(() => window.syntheticUnsafeEvalRan), undefined)

  stage = 'inline and external script/style/base denial'
  await page.evaluate((hostile) => {
    const script = document.createElement('script')
    script.textContent = 'window.syntheticUnsafeScriptRan = true'
    document.head.append(script)
    const external = document.createElement('script')
    external.src = `${hostile}/script.js`
    document.head.append(external)
    const style = document.createElement('style')
    style.textContent = 'body { outline: 7px solid rgb(1, 2, 3) !important; }'
    document.head.append(style)
    const base = document.createElement('base')
    base.href = hostile
    document.head.append(base)
  }, hostile)
  await expect.poll(() => page.evaluate(() => window.syntheticCSPViolations)).toEqual(expect.arrayContaining(['script-src', 'script-src-elem', 'style-src-elem', 'base-uri']))
  assert.equal(await page.evaluate(() => window.syntheticUnsafeScriptRan), undefined)
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).outlineWidth), '7px')
  assert.ok((await page.evaluate(() => document.baseURI)).startsWith(origin.origin))
  assert.equal(attackRequests, 0)

  stage = 'cross-origin form denial'
  await page.evaluate((hostile) => {
    const form = document.createElement('form')
    form.action = `${hostile}/form`
    form.method = 'POST'
    document.body.append(form)
    form.submit()
  }, hostile)
  await expect.poll(() => page.evaluate(() => window.syntheticCSPViolations)).toContain('form-action')
  assert.equal(attackRequests, 0)
  assert.ok(page.url().startsWith(origin.origin))

  stage = 'framing denial'
  const framing = await browser.newPage()
  let blockedFrame = false
  framing.on('console', (message) => {
    if (/frame-ancestors|X-Frame-Options/.test(message.text())) blockedFrame = true
  })
  await framing.goto(`${hostile}/frame`)
  await expect.poll(() => blockedFrame).toBe(true)
  assert.equal(framing.frames().some((frame) => frame.url().startsWith(origin.origin)), false)
  console.log('Built UI/icon CSS and real same-origin API verified under declared CSP; eval/inline/external script, style, base, form and frame attacks blocked.')
} catch {
  console.error(`Built artifact CSP verification failed: ${stage}.`)
  process.exitCode = 1
} finally {
  await browser?.close()
  if (attacker) await new Promise((resolve) => attacker.close(resolve))
}
