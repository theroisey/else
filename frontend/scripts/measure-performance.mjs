// Opt-in laboratory measurements; never production telemetry or field Web Vitals.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { completeEmailSignIn } from './otp-fixture.mjs'

const origin = process.env.AUTH_TEST_ORIGIN
const directory = process.env.AUTH_TEST_DIRECTORY
if (
  !origin ||
  new URL(origin).hostname !== '127.0.0.1' ||
  !directory ||
  readFileSync(join(directory, '.fixture-control'), 'utf8') !==
    'disposable-synthetic-browser-fixture'
) {
  throw new Error('An owned disposable browser fixture is required.')
}
const output = process.argv[2]
if (!output) throw new Error('An output path is required.')
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
    : {}),
})
const samples = []
const profiles = [
  {
    name: 'desktop',
    viewport: { width: 1440, height: 900 },
    cpu: 1,
    latency: 40,
    download: 1_250_000,
  },
  {
    name: 'mobile-lab',
    viewport: { width: 390, height: 844 },
    cpu: 4,
    latency: 60,
    download: 400_000,
  },
]
try {
  for (const profile of profiles) {
    for (const locale of ['en', 'tr']) {
      for (let run = 0; run < 3; run++) {
        const context = await browser.newContext({
          viewport: profile.viewport,
          locale: 'en-US',
        })
        const page = await context.newPage()
        const pendingAssets = new Set()
        page.on('request', (request) => {
          const path = new URL(request.url()).pathname
          if (path.startsWith('/assets/')) pendingAssets.add(path)
        })
        for (const event of ['requestfinished', 'requestfailed'])
          page.on(event, (request) =>
            pendingAssets.delete(new URL(request.url()).pathname),
          )
        const errors = []
        page.on('pageerror', () => errors.push('pageerror'))
        await page.addInitScript((locale) => {
          localStorage.setItem('roisey-else.locale', locale)
          const metrics = {
            lcp: 0,
            cls: 0,
            longTasks: 0,
            longTaskMs: 0,
            interactionMax: 0,
          }
          let sessionStart = 0,
            sessionLast = 0,
            sessionValue = 0
          for (const type of [
            'largest-contentful-paint',
            'layout-shift',
            'longtask',
          ]) {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                if (type === 'largest-contentful-paint')
                  metrics.lcp = entry.startTime
                if (type === 'longtask') {
                  metrics.longTasks++
                  metrics.longTaskMs += entry.duration
                }
                if (type === 'layout-shift' && !entry.hadRecentInput) {
                  if (
                    entry.startTime - sessionLast > 1000 ||
                    entry.startTime - sessionStart > 5000
                  ) {
                    sessionStart = entry.startTime
                    sessionValue = 0
                  }
                  sessionLast = entry.startTime
                  sessionValue += entry.value
                  metrics.cls = Math.max(metrics.cls, sessionValue)
                }
              }
            }).observe({ type, buffered: true })
          }
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              if (entry.interactionId)
                metrics.interactionMax = Math.max(
                  metrics.interactionMax,
                  entry.duration,
                )
          }).observe({ type: 'event', buffered: true, durationThreshold: 16 })
          Object.assign(window, { syntheticPerformance: metrics })
        }, locale)
        const devtools = await context.newCDPSession(page)
        await devtools.send('Network.enable')
        await devtools.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: profile.latency,
          downloadThroughput: profile.download,
          uploadThroughput: 250_000,
        })
        await devtools.send('Emulation.setCPUThrottlingRate', {
          rate: profile.cpu,
        })
        await devtools.send('Performance.enable')
        try {
          await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' })
        } catch (error) {
          console.error(
            JSON.stringify({
              phase: 'cold navigation',
              profile: profile.name,
              locale,
              run: run + 1,
              pendingPublicAssets: [...pendingAssets],
            }),
          )
          throw error
        }
        await page.locator('input[type="email"]').waitFor()
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        )
        const cold = await page.evaluate(() => ({
          ...window.syntheticPerformance,
          fcp:
            performance.getEntriesByName('first-contentful-paint')[0]
              ?.startTime ?? 0,
          ready: performance.now(),
          jsBytes: performance
            .getEntriesByType('resource')
            .filter(
              (r) =>
                r.initiatorType === 'script' ||
                new URL(r.name).pathname.endsWith('.js'),
            )
            .reduce((n, r) => n + r.encodedBodySize, 0),
          jsRequests: performance
            .getEntriesByType('resource')
            .filter((r) => new URL(r.name).pathname.endsWith('.js')).length,
        }))
        const cpu = Object.fromEntries(
          (await devtools.send('Performance.getMetrics')).metrics.map((m) => [
            m.name,
            m.value,
          ]),
        )
        const sample = {
          profile: profile.name,
          locale,
          run: run + 1,
          cold,
          scriptMs: cpu.ScriptDuration * 1000,
          taskMs: cpu.TaskDuration * 1000,
        }
        if (locale === 'en') {
          await page
            .locator('input[type="email"]')
            .fill(
              run % 2
                ? 'browser.fixture@example.com'
                : 'admin.fixture@example.com',
            )
          await completeEmailSignIn(page)
          await page
            .getByRole('heading', { name: 'Today', exact: true })
            .waitFor()
          const nav = page.getByRole('navigation', {
            name: 'Application',
            exact: true,
          })
          const route = async (name, heading) => {
            if (!(await nav.isVisible()))
              await page
                .locator('[aria-controls="application-navigation"]')
                .click()
            const link = nav.getByRole('link', { name, exact: true })
            // Start at the real DOM click, excluding Playwright pointer/stability waits.
            await link.evaluate((element, heading) => {
              window.syntheticRouteMs = null
              element.addEventListener(
                'click',
                () => {
                  const started = performance.now()
                  const observer = new MutationObserver(() => {
                    if (
                      ![
                        ...document.querySelectorAll('#workspace-content h1'),
                      ].some((el) => el.textContent === heading)
                    )
                      return
                    observer.disconnect()
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => {
                        window.syntheticRouteMs = performance.now() - started
                      }),
                    )
                  })
                  observer.observe(
                    document.getElementById('workspace-content'),
                    { childList: true, subtree: true },
                  )
                },
                { once: true },
              )
            }, heading)
            await link.click()
            await page
              .getByRole('heading', { name: heading, exact: true })
              .waitFor()
            await page.waitForFunction(() => window.syntheticRouteMs !== null)
            return Math.round(
              await page.evaluate(() => window.syntheticRouteMs),
            )
          }
          sample.clientsMs = await route('Clients', 'Clients')
          sample.settingsMs = await route('Settings', 'Settings')
          sample.cachedClientsMs = await route('Clients', 'Clients')
          sample.interactionMaxMs = await page.evaluate(
            () => window.syntheticPerformance.interactionMax,
          )
          // Same build warm navigation, including auth/session discovery.
          await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' })
          await page
            .getByRole('heading', { name: 'Today', exact: true })
            .waitFor()
          sample.warmWorkspaceMs = await page.evaluate(() => performance.now())
        }
        sample.errors = errors.length
        samples.push(sample)
        writeFileSync(output, JSON.stringify({ samples }, null, 2) + '\n')
        console.log(
          `${profile.name} ${locale} sample ${run + 1}: ready=${Math.round(cold.ready)}ms`,
        )
        await context.close()
      }
    }
  }
  const report = {
    environment: {
      browser: browser.version(),
      profiles,
      repetitions: 3,
      fixture: 'isolated synthetic SQLite via native Pingora',
      note: 'Lab samples and click-to-heading timings; not field p75 LCP/INP or a physical mobile benchmark.',
    },
    samples,
  }
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  for (const profile of profiles) {
    for (const locale of ['en', 'tr']) {
      const rows = samples.filter(
        (s) => s.profile === profile.name && s.locale === locale,
      )
      const median = (values) => [...values].sort((a, b) => a - b)[1]
      console.log(
        JSON.stringify({
          profile: profile.name,
          locale,
          lcp: median(rows.map((s) => s.cold.lcp)),
          cls: median(rows.map((s) => s.cold.cls)),
          ready: median(rows.map((s) => s.cold.ready)),
          jsBytes: median(rows.map((s) => s.cold.jsBytes)),
          jsRequests: median(rows.map((s) => s.cold.jsRequests)),
          scriptMs: median(rows.map((s) => s.scriptMs)),
          ...(locale === 'en'
            ? {
                clientsMs: median(rows.map((s) => s.clientsMs)),
                cachedClientsMs: median(rows.map((s) => s.cachedClientsMs)),
              }
            : {}),
        }),
      )
    }
  }
} finally {
  await browser.close()
}
