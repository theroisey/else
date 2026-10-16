// Chromium enforcement/compatibility against a built artifact and real API.
// Actual application-image header application is checked independently in Container CI.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
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
  const page = await browser.newPage()
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
  const appleIcons = [[152, '/assets/roisey-else-app-152-v2.png'], [167, '/assets/roisey-else-app-167-v2.png'], [180, '/apple-touch-icon.png?v=2']]
  assert.equal(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute('content'), 'yes')
  for (const [size, path] of appleIcons) {
    assert.equal(await page.locator(`link[rel="apple-touch-icon"][sizes="${size}x${size}"]`).getAttribute('href'), path)
  }
  assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'), '/app.webmanifest?v=2')
  stage = 'mobile manifest response'
  const manifestResponse = await page.request.get(origin.origin + '/app.webmanifest?v=2')
  assert.equal(manifestResponse.status(), 200)
  assert.equal(manifestResponse.headers()['content-type'], 'application/manifest+json; charset=utf-8')
  assert.equal(manifestResponse.headers()['cache-control'], 'no-cache')
  const manifest = await manifestResponse.json()
  assert.equal(manifest.id, '/app')
  assert.equal(manifest.start_url, '/app')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.deepEqual(manifest.icons, [192, 512].map(size => ({ src: `/assets/roisey-else-app-${size}-v2.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })))
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
    assert.equal(parsed.url, origin.origin + '/app.webmanifest?v=2')
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
    script.src = '/assets/_security-test-eval.js'
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
