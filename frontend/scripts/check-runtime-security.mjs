// Chromium enforcement/compatibility against a built artifact and real API.
// Actual application-image header application is checked independently in Container CI.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { chromium, expect } from '@playwright/test'

let stage = 'private origin'
let browser
let attacker
let page
const pageErrorKinds = new Set()
const failedResponses = new Map()
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
      response.end(`<iframe src="${origin.origin}/app/portfolio"></iframe>`)
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
  page = await browser.newPage()
  page.on('pageerror', error => {
    const known = ['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'RangeError', 'AbortError', 'TimeoutError', 'SecurityError']
    pageErrorKinds.add(known.includes(error.name) ? error.name : 'OtherError')
  })
  page.on('response', response => {
    if (response.status() < 400) return
    const path = new URL(response.url()).pathname
    const kind = ['/api/v1/auth/session', '/api/v1/auth/refresh'].includes(path)
      ? path : path.startsWith('/assets/') ? 'public-asset' : 'other'
    const key = `${kind}:${response.status()}`
    if (failedResponses.size < 12 || failedResponses.has(key))
      failedResponses.set(key, Math.min(99, (failedResponses.get(key) ?? 0) + 1))
  })
  // Test-only ordinary script, fulfilled at a same-origin URL. It executes under
  // the real page's CSP without adding a probe to production image artifacts.
  await page.route(`${origin.origin}/assets/_security-test-eval.js`, (route) => route.fulfill({
    contentType: 'application/javascript',
    body: 'window.syntheticEvalProbeLoaded = true; try { new Function("window.syntheticUnsafeEvalRan = true")() } catch {}',
  }))
  await page.addInitScript(() => {
    window.syntheticCSPViolations = []
    window.syntheticCSPKinds = []
    document.addEventListener('securitypolicyviolation', (event) => {
      window.syntheticCSPViolations.push(event.effectiveDirective)
      window.syntheticCSPKinds.push(['eval', 'inline'].includes(event.blockedURI) ? event.blockedURI : 'source')
    })
  })
  stage = 'built sign-in rendering'
  await page.goto(`${origin.origin}/app/portfolio`)
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
  stage = 'mobile app icon metadata'
  const favicons = [[16, '/assets/favicon-16.png'], [32, '/assets/favicon-32.png']]
  assert.equal(await page.locator('link[rel="icon"]').count(), favicons.length)
  for (const [size, path] of favicons) {
    assert.equal(await page.locator(`link[rel="icon"][sizes="${size}x${size}"]`).getAttribute('href'), path)
    const response = await page.request.get(origin.origin + path)
    assert.equal(response.status(), 200)
    assert.equal(response.headers()['content-type'], 'image/png')
    assert.equal(response.headers()['cache-control'], 'no-cache')
    const body = await response.body()
    assert.deepEqual(body, readFileSync(new URL(`../public${path}`, import.meta.url)))
    assert.equal(body.readUInt32BE(16), size)
    assert.equal(body.readUInt32BE(20), size)
  }
  const appleIcons = [[152, '/assets/apple-touch-icon-152.png'], [167, '/assets/apple-touch-icon-167.png'], [180, '/apple-touch-icon.png?v=3']]
  assert.equal(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute('content'), 'yes')
  for (const [size, path] of appleIcons) {
    assert.equal(await page.locator(`link[rel="apple-touch-icon"][sizes="${size}x${size}"]`).getAttribute('href'), path)
  }
  assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'), '/app.webmanifest?v=3')
  stage = 'mobile manifest response'
  const manifestResponse = await page.request.get(origin.origin + '/app.webmanifest?v=3')
  assert.equal(manifestResponse.status(), 200)
  assert.equal(manifestResponse.headers()['content-type'], 'application/manifest+json; charset=utf-8')
  assert.equal(manifestResponse.headers()['cache-control'], 'no-cache')
  const manifest = await manifestResponse.json()
  assert.equal(manifest.id, '/app')
  assert.equal(manifest.start_url, '/app')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.deepEqual(manifest.icons, [192, 512].map(size => ({ src: `/assets/android-chrome-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })))
  stage = 'platform PNG icon delivery and decoding'
  for (const [size, path] of [...appleIcons, ...manifest.icons.map(icon => [Number(icon.sizes.split('x')[0]), icon.src])]) {
    const response = await page.request.get(origin.origin + path)
    assert.equal(response.status(), 200)
    assert.equal(response.headers()['content-type'], 'image/png')
    const body = await response.body()
    assert.deepEqual(body, readFileSync(new URL(`../public${path.split('?')[0]}`, import.meta.url)))
    assert.equal(body.readUInt32BE(16), size)
    assert.equal(body.readUInt32BE(20), size)
    assert.equal(await page.evaluate(async ({ path, size }) => {
      const image = new Image()
      image.src = path
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, size, size).data
      let white = 0
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240 && pixels[i + 3] === 255) white++
      }
      return image.naturalWidth === size && image.naturalHeight === size && white > size * size / 100 && pixels[3] === 255
    }, { path, size }), true)
  }
  for (const fallback of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
    const response = await page.request.get(origin.origin + fallback)
    assert.equal(response.status(), 200)
    assert.deepEqual(await response.body(), readFileSync(new URL('../public/apple-touch-icon.png', import.meta.url)))
  }
  const devtools = await page.context().newCDPSession(page)
  try {
    stage = 'native mobile manifest parsing'
    const parsed = await devtools.send('Page.getAppManifest')
    assert.equal(parsed.url, origin.origin + '/app.webmanifest?v=3')
    assert.deepEqual(parsed.errors, [])
    stage = 'native mobile icon suitability'
    const { installabilityErrors } = await devtools.send('Page.getInstallabilityErrors')
    stage += ` (${installabilityErrors.map(({ errorId }) => /^[a-z0-9-]{1,80}$/.test(errorId) ? errorId : 'unrecognized').join(', ')})`
    assert.deepEqual(installabilityErrors.filter(({ errorId }) => /icon/i.test(errorId)), [])
  } finally {
    await devtools.detach()
  }
  stage = 'real failed-login response'
  await page.getByLabel('Email', { exact: true }).fill('csp.synthetic@example.com')

  await page.getByRole('button', { name: 'Continue with email', exact: true }).click()
  await page.getByLabel('Verification code',{exact:true}).fill('000000')
  await page.getByRole('button',{name:'Verify and sign in',exact:true}).click()
  await expect(page.getByRole('alert')).toHaveText('The code is incorrect or no longer available. Request a new code if needed.')
  stage = 'real API readiness'
  assert.equal(await page.evaluate(async () => (await fetch('/ready')).status), 200)
  stage = 'legitimate UI without CSP violations'
  const legitimateViolations = await page.evaluate(() => window.syntheticCSPViolations)
  stage += ` (${legitimateViolations.filter((value) => /^[a-z-]+$/.test(value)).join(', ')})`
  stage += ` (${(await page.evaluate(() => window.syntheticCSPKinds)).join(', ')})`
  assert.deepEqual(legitimateViolations, [])

  stage = 'optional Cloudflare beacon script and same-origin transport'
  await page.route('https://static.cloudflareinsights.com/beacon.min.js', route => route.fulfill({
    contentType: 'text/javascript', body: 'window.syntheticBeaconLoaded = true; navigator.sendBeacon("/cdn-cgi/rum", "synthetic timing");',
  }))
  await page.route(`${origin.origin}/cdn-cgi/rum`, route => route.fulfill({ status: 204 }))
  const beacon = page.waitForRequest(`${origin.origin}/cdn-cgi/rum`)
  await page.evaluate(() => {
    const script = document.createElement('script')
    script.src = 'https://static.cloudflareinsights.com/beacon.min.js'
    document.head.append(script)
  })
  assert.equal((await beacon).method(), 'POST')
  assert.equal(await page.evaluate(() => window.syntheticBeaconLoaded), true)
  assert.deepEqual(await page.evaluate(() => window.syntheticCSPViolations), [])
  const declared = JSON.parse(readFileSync(new URL('../../backend/internal/http/browser-headers.json', import.meta.url), 'utf8'))
  const policy = (await page.request.get(origin.origin + '/login')).headers()['content-security-policy']
  assert.equal(policy, declared['Content-Security-Policy'])

  // DevTools evaluation can bypass code-generation policy. A normal allowed
  // same-origin script must attempt eval for real browser enforcement proof.
  stage = 'eval denial from ordinary same-origin script'
  await page.evaluate(() => new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/assets/_security-test-eval.js'
    script.onload = resolve
    script.onerror = reject
    document.head.append(script)
  }))
  assert.equal(await page.evaluate(() => window.syntheticEvalProbeLoaded), true)
  await expect.poll(() => page.evaluate(() => window.syntheticCSPViolations)).toContain('script-src')
  assert.equal(await page.evaluate(() => window.syntheticUnsafeEvalRan), undefined)

  stage = 'inline and external script/style/base denial'
  let unapprovedBeaconRequests = 0
  await page.route('https://static.cloudflareinsights.com/unapproved.js', route => {
    unapprovedBeaconRequests++
    return route.fulfill({ contentType: 'text/javascript', body: 'window.syntheticUnsafeScriptRan = true' })
  })
  await page.evaluate((hostile) => {
    const script = document.createElement('script')
    script.textContent = 'window.syntheticUnsafeScriptRan = true'
    document.head.append(script)
    const external = document.createElement('script')
    external.src = `${hostile}/script.js`
    document.head.append(external)
    const unapproved = document.createElement('script')
    unapproved.src = 'https://static.cloudflareinsights.com/unapproved.js'
    document.head.append(unapproved)
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
  assert.equal(unapprovedBeaconRequests, 0)

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
  console.log('Built UI/icons/API and optional Cloudflare beacon verified under declared CSP; eval/inline/unapproved script, style, base, form and frame attacks blocked.')
} catch {
  console.error(`Built artifact CSP verification failed: ${stage}.`)
  // Fixed categories/booleans only: no body, heading, URL parameters, mailbox,
  // credential, raw exception, screenshot or browser storage is disclosed.
  if (page) {
    try {
      const surface = await page.evaluate(() => ({
        documentReady: ['loading', 'interactive', 'complete'].includes(document.readyState) ? document.readyState : 'other',
        knownRoute: ['/login', '/app/portfolio'].includes(location.pathname),
        locale: ['en', 'tr', 'ro', 'de', 'fr'].includes(document.documentElement.lang) ? document.documentElement.lang : 'other',
        signIn: [...document.querySelectorAll('h1')].some(node => node.textContent === 'Sign in'),
        sessionUnavailable: [...document.querySelectorAll('h1')].some(node => node.textContent === 'Session check unavailable'),
        emailField: Boolean(document.querySelector('input[name="email"]')),
        codeField: Boolean(document.querySelector('input[name="code"]')),
        statusSurface: Boolean(document.querySelector('[role="status"]')),
        csp: (window.syntheticCSPViolations ?? []).slice(0, 12).map(value => /^[a-z-]{1,40}$/.test(value) ? value : 'other'),
      }))
      console.error(JSON.stringify({ diagnostic: 'built-ui-preflight', surface, pageErrorKinds: [...pageErrorKinds], failedResponses: Object.fromEntries(failedResponses) }))
    } catch { console.error('Built UI preflight surface unavailable.') }
  }
  process.exitCode = 1
} finally {
  await browser?.close()
  if (attacker) await new Promise((resolve) => attacker.close(resolve))
}
