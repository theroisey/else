import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const dist = new URL('../dist/', import.meta.url)
const html = readFileSync(new URL('index.html', dist), 'utf8')
assert.ok(
  !html.includes('/node_modules/') && !html.includes('/src/'),
  'Development references in production HTML',
)
function checkReference(reference, parent = 'index.html') {
  const url = reference.startsWith('/')
    ? new URL(reference.slice(1), dist)
    : new URL(reference, new URL(parent, dist))
  assert.ok(
    url.href.startsWith(dist.href),
    'Asset reference leaves production directory',
  )
  url.search = url.hash = ''
  assert.ok(
    statSync(url).isFile() && statSync(url).size > 0,
    `Missing production asset: ${reference}`,
  )
}
for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g))
  checkReference(reference)
const cssFiles = readdirSync(new URL('assets/', dist)).filter((file) =>
  file.endsWith('.css'),
)
const css = cssFiles.map((file) =>
  readFileSync(new URL('assets/' + file, dist), 'utf8'),
)
for (const [index, text] of css.entries()) {
  for (const [, reference] of text.matchAll(/url\(["']?([^\s)"']+)["']?\)/g))
    checkReference(reference, 'assets/' + cssFiles[index])
}
for (const [tag] of html.matchAll(/<link\b[^>]*as="font"[^>]*>/g)) {
  assert.match(
    tag,
    /\bcrossorigin(?:\s|=|\/|>)/,
    'Font preload must use anonymous CORS',
  )
  const file =
    /href="[^"/]*\/([^"/]+)"/.exec(tag)?.[1] ??
    /href="\/assets\/([^"]+)"/.exec(tag)?.[1]
  assert.ok(
    file && css.some((text) => text.includes(file)),
    'Preloaded font is not used by production CSS',
  )
}
const initial = new Set()
for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
  if (!tag.startsWith('<script') && !tag.includes('rel="modulepreload"'))
    continue
  const path = /(?:src|href)="((?:\/assets\/[^"/]+|\/startup)\.js)"/.exec(
    tag,
  )?.[1]
  if (path) initial.add(path.slice(1))
}
assert.ok(initial.size > 1, 'Missing application bootstrap')
const encoded = (path) =>
  gzipSync(readFileSync(new URL(path, dist)), { level: 9 }).length
const initialBytes = [...initial].reduce((sum, path) => sum + encoded(path), 0)
assert.ok(
  initialBytes <= 250_000,
  `Initial JavaScript exceeds 250 KB gzip: ${initialBytes}`,
)
assert.ok(
  [...initial].every(
    (path) =>
      !/\/(?:tr|ro|de|fr|UsersPage|RolesPage|FinancePage|RequestDetailPage|InterfaceReviewPage)-/.test(
        path,
      ),
  ),
  'Optional language or heavy page loaded before sign-in',
)
const files = readdirSync(new URL('assets/', dist)).filter((file) =>
  file.endsWith('.js'),
)
const totalBytes = files.reduce(
  (sum, file) => sum + readFileSync(new URL('assets/' + file, dist)).length,
  0,
)
for (const file of files) {
  const source = readFileSync(new URL('assets/' + file, dist), 'utf8')
  for (const [, reference] of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+)["']/g,
  ))
    checkReference(reference, 'assets/' + file)
  for (const [, reference] of source.matchAll(
    /["'](assets\/[^"']+\.(?:js|css))["']/g,
  ))
    checkReference(reference)
}
assert.ok(totalBytes < 3 * 1024 * 1024, 'Total JavaScript exceeds 3 MiB')
for (const language of ['tr', 'ro', 'de', 'fr']) {
  const chunks = files.filter((file) => file.startsWith(language + '-'))
  assert.equal(chunks.length, 1, `Expected one chunk for ${language}`)
  assert.ok(
    encoded('assets/' + chunks[0]) < 70_000,
    'Language chunk exceeds 70 KB gzip',
  )
}
console.log(
  JSON.stringify({
    initial_js_gzip_bytes: initialBytes,
    initial_js_requests: initial.size,
    total_js_bytes: totalBytes,
    budgets: 'passed',
  }),
)
