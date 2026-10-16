// Real browser + real Pingora assets, with an owned loopback gateway simulating
// deployment replacement and challenge responses. No production edge requests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { chromium, expect } from '@playwright/test'

const upstream = new URL(process.argv[2])
assert.equal(upstream.hostname, '127.0.0.1')
assert.equal(upstream.protocol, 'http:')
assert.equal(upstream.pathname, '/')
let stage = 'production public artifact'
let browser
let gateway
try {
  const html = await (await fetch(new URL('/login', upstream))).text()
  const oldPath = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1]
  assert.ok(oldPath)
  const original = await (await fetch(new URL(oldPath, upstream))).text()
  const worker = await (await fetch(new URL('/sw.js', upstream))).text()
  const inventory = JSON.parse(/^const ASSETS = (.+)$/m.exec(worker)[1])
  const nextPath = '/assets/index-AbCd1234.js'
  const nextBody = original + '\n/* synthetic next deployment */'
  const nextInventory = { ...inventory }
  delete nextInventory[oldPath]
  nextInventory[nextPath] = {
    mime: 'text/javascript',
    size: Buffer.byteLength(nextBody),
    sha256: createHash('sha256').update(nextBody).digest('hex'),
  }
  const nextWorker = worker
    .replace(/^const BUILD = '[^']+'/m, "const BUILD = 'synthetic-next'")
    .replace(JSON.stringify(inventory), JSON.stringify(nextInventory))
  let deployed = false
  let blockNextEntry = false
  let override
  let assetRequests = 0
  let credentialRequests = 0
  gateway = createServer((req, res) => {
    const path = new URL(req.url, upstream).pathname
    const serve = (body, mime, cacheControl = 'no-cache') => {
      res.writeHead(200, {
        'content-type': mime,
        'cache-control': cacheControl,
        etag: `"${createHash('sha256').update(body).digest('hex')}"`,
      })
      res.end(body)
    }
    if (path === '/sw.js')
      return serve(deployed ? nextWorker : worker, 'text/javascript')
    if (path === nextPath && deployed && blockNextEntry) {
      res.writeHead(403, {
        'content-type': 'text/html',
        'cache-control': 'no-store',
      })
      return res.end('synthetic stale-worker challenge')
    }
    if (path === nextPath && deployed)
      return serve(
        nextBody,
        'text/javascript',
        'public, max-age=31536000, immutable',
      )
    if (path === oldPath) {
      assetRequests++
      if (req.headers.cookie?.includes('synthetic_clearance=verified'))
        credentialRequests++
      if (deployed) {
        res.writeHead(404, { 'cache-control': 'no-store' })
        return res.end('synthetic obsolete asset')
      }
      if (override) {
        res.writeHead(override.status, override.headers)
        return res.end(override.body)
      }
    }
    const target = new URL(req.url, upstream)
    const call = httpRequest(
      target,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: upstream.host,
          'accept-encoding': 'identity',
        },
      },
      (response) => {
        if (deployed && path === '/login') {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            const changed = Buffer.concat(chunks)
              .toString()
              .replace(oldPath, nextPath)
            const headers = {
              ...response.headers,
              'content-length': Buffer.byteLength(changed),
              etag: `"${createHash('sha256').update(changed).digest('hex')}"`,
            }
            res.writeHead(response.statusCode, headers)
            res.end(changed)
          })
        } else {
          res.writeHead(response.statusCode, response.headers)
          response.pipe(res)
        }
      },
    )
    call.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(call)
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${gateway.address().port}`
  browser = await chromium.launch(
    process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {},
  )
  const context = await browser.newContext()
  await context.addCookies([
    { name: 'synthetic_clearance', value: 'verified', url: origin },
  ])
  let page = await context.newPage()
  stage = 'fresh browser and worker registration'
  await page.goto(origin + '/login')
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await navigator.serviceWorker.getRegistration())?.active?.state,
      ),
    )
    .toBe('activated')
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible()
  assert.equal(
    await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    true,
  )
  const devtools = await context.newCDPSession(page)
  await devtools.send('Network.enable')
  const clear = async () => {
    await page.evaluate(async (path) => {
      for (const name of await caches.keys())
        if (name.startsWith('roisey-else-public-assets-v2-'))
          await (await caches.open(name)).delete(path)
    }, oldPath)
    await devtools.send('Network.clearBrowserCache')
  }
  const read = async () =>
    page.evaluate(async (path) => {
      const response = await fetch(path)
      return { status: response.status, body: await response.text() }
    }, oldPath)
  const cached = async () =>
    page.evaluate(async (path) => {
      for (const name of await caches.keys())
        if (
          name.startsWith('roisey-else-public-assets-v2-') &&
          (await (await caches.open(name)).match(path))
        )
          return true
      return false
    }, oldPath)
  stage = 'network credentials survive worker interception'
  await clear()
  assetRequests = credentialRequests = 0
  assert.equal((await read()).body, original)
  await expect.poll(cached).toBe(true)
  assert.equal(assetRequests, 1)
  assert.equal(credentialRequests, 1)
  stage =
    'verified cached code survives offline while APIs and documents bypass cache'
  await devtools.send('Network.clearBrowserCache')
  await context.setOffline(true)
  assert.equal((await read()).body, original)
  assert.equal(
    await page.evaluate(async () => {
      try {
        await fetch('/api/v1/auth/session')
        return false
      } catch {
        return true
      }
    }),
    true,
  )
  await context.setOffline(false)
  const cachedPaths = await page.evaluate(async () => {
    const paths = []
    for (const name of await caches.keys())
      if (name.startsWith('roisey-else-public-assets-v2-'))
        for (const key of await (await caches.open(name)).keys())
          paths.push(new URL(key.url).pathname)
    return paths
  })
  assert.ok(
    cachedPaths.length > 0 &&
      cachedPaths.every(
        (path) =>
          path.startsWith('/assets/') && /\.(js|css|woff2?|ttf)$/.test(path),
      ),
  )
  stage = 'challenge and error responses never poison public cache'
  for (const candidate of [
    ...[401, 403, 404, 429, 503].map((status) => ({
      status,
      headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
      body: 'synthetic failure',
    })),
    {
      status: 200,
      headers: { 'content-type': 'text/html', 'cache-control': 'public' },
      body: '<html>synthetic challenge</html>',
    },
    {
      status: 200,
      headers: {
        'content-type': 'text/javascript',
        'cache-control': 'public, immutable',
      },
      body: '/* mismatched deployment */',
    },
  ]) {
    await clear()
    override = candidate
    const before = assetRequests
    assert.equal((await read()).status, candidate.status)
    assert.equal(await cached(), false)
    assert.equal(assetRequests, before + 1)
  }
  override = undefined
  await read()
  await expect.poll(cached).toBe(true)
  stage = 'waiting update preserves current client and unsaved input'
  await page
    .getByLabel('Email', { exact: true })
    .fill('unsaved.synthetic@example.com')
  await page.evaluate(async () => {
    await caches.open('unrelated-cache')
    await caches.open('roisey-else-public-assets-v2-obsolete')
    await caches.open('roisey-else-public-assets-v1')
    window.syntheticControllerChanges = 0
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.syntheticControllerChanges++
    })
  })
  deployed = true
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    await registration.update()
  })
  await expect
    .poll(() =>
      page.evaluate(async () =>
        Boolean((await navigator.serviceWorker.getRegistration()).waiting),
      ),
    )
    .toBe(true)
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
    'unsaved.synthetic@example.com',
  )
  assert.equal(await page.evaluate(() => window.syntheticControllerChanges), 0)
  assert.equal((await page.request.get(origin + oldPath)).status(), 404)
  assert.equal((await read()).body, original)
  stage =
    'failed startup explains an existing waiting update without replacing open drafts'
  blockNextEntry = true
  const blocked = await context.newPage()
  await blocked.goto(origin + '/login')
  await expect(
    blocked.getByText(/Save work in other tabs, close all Roisey Else/),
  ).toBeVisible()
  await expect(blocked.locator('#startup-reload')).toHaveCount(0)
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
    'unsaved.synthetic@example.com',
  )
  await blocked.close()
  blockNextEntry = false
  stage =
    'new deployment activates after old client closes and cleans only owned obsolete caches'
  await devtools.detach()
  await page.close()
  await expect
    .poll(async () => {
      for (const worker of context.serviceWorkers()) {
        try {
          if (
            await worker.evaluate(
              () =>
                self.registration.active?.state === 'activated' &&
                !self.registration.waiting,
            )
          )
            return true
        } catch {
          /* The old worker target may close during normal activation. */
        }
      }
      return false
    })
    .toBe(true)
  page = await context.newPage()
  await page.goto(origin + '/login')
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await caches.keys()).filter((name) =>
          name.startsWith('roisey-else-public-assets-v2-'),
        ),
      ),
    )
    .toEqual(['roisey-else-public-assets-v2-synthetic-next'])
  assert.ok(
    (await page.evaluate(() => caches.keys())).includes('unrelated-cache'),
  )
  stage = 'failed initial entry offers explicit recovery without reload loops'
  const failedContext = await browser.newContext({ serviceWorkers: 'block' })
  const failed = await failedContext.newPage()
  let attempts = 0
  await failed.route('**' + nextPath, (route) => {
    attempts++
    return route.fulfill({
      status: 403,
      contentType: 'text/html',
      body: 'synthetic challenge',
    })
  })
  await failed.goto(origin + '/login')
  await expect(
    failed.getByRole('heading', {
      name: 'Application could not load',
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    failed.getByRole('button', { name: 'Reload application', exact: true }),
  ).toBeVisible()
  assert.equal(attempts, 1)
  await failed.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await failed.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await failed.screenshot({
    path: new URL(
      '../test-results/SYNTHETIC-startup-recovery-light.png',
      import.meta.url,
    ).pathname,
  })
  await failed.evaluate(() => {
    localStorage.setItem('roisey-else.appearance', 'dark')
    localStorage.setItem('roisey-else.locale', 'tr')
  })
  await failed.reload()
  await expect(
    failed.getByRole('heading', { name: 'Uygulama yüklenemedi', exact: true }),
  ).toBeVisible()
  await failed.screenshot({
    path: new URL(
      '../test-results/SYNTHETIC-startup-recovery-dark.png',
      import.meta.url,
    ).pathname,
  })
  await failed.evaluate(() => localStorage.setItem('roisey-else.locale', 'en'))
  await failed.unroute('**' + nextPath)
  await failed.locator('#startup-reload').click()
  await expect(
    failed.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible()
  stage = 'optional beacon failure cannot replace the initial application'
  const optional = await failedContext.newPage()
  let releaseEntry
  const entryGate = new Promise((resolve) => {
    releaseEntry = resolve
  })
  await optional.route('**' + nextPath, async (route) => {
    await entryGate
    await route.continue()
  })
  await optional.route(
    'https://static.cloudflareinsights.com/beacon.min.js',
    (route) =>
      route.fulfill({
        status: 404,
        contentType: 'text/javascript',
        headers: { 'access-control-allow-origin': '*' },
        body: '/* synthetic optional failure */',
      }),
  )
  await optional.goto(origin + '/login', { waitUntil: 'commit' })
  await optional.locator('#root').waitFor({ state: 'attached' })
  await optional.evaluate(
    () =>
      new Promise((resolve) => {
        const script = document.createElement('script')
        script.type = 'module'
        script.src = 'https://static.cloudflareinsights.com/beacon.min.js'
        script.onerror = () => resolve(true)
        document.head.append(script)
      }),
  )
  await expect(optional.locator('#startup-error')).not.toBeVisible()
  releaseEntry()
  await expect(
    optional.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible()
  console.log(
    'Real-browser public cache credentials, challenges, offline isolation, safe deployment update and explicit startup recovery passed.',
  )
} catch (error) {
  console.error(`Public cache browser verification failed: ${stage}.`)
  console.error(error instanceof Error ? error.message : 'Verification failed')
  process.exitCode = 1
} finally {
  await browser?.close()
  if (gateway) {
    gateway.closeAllConnections()
    await new Promise((resolve) => gateway.close(resolve))
  }
}
