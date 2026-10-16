import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

const dist = new URL('../dist/', import.meta.url)
const assets = {}
const mime = {
  js: 'text/javascript',
  css: 'text/css',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
}
for (const name of readdirSync(new URL('assets/', dist)).sort()) {
  const extension = /-[\w-]{8}\.(js|css|woff2?|ttf)$/.exec(name)?.[1]
  if (!extension) continue
  const bytes = readFileSync(new URL('assets/' + name, dist))
  assert.ok(
    bytes.length > 0 && bytes.length <= 1024 * 1024,
    'Public asset exceeds cache entry bound',
  )
  assets['/assets/' + name] = {
    mime: mime[extension],
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
assert.ok(
  Object.keys(assets).length > 0 && Object.keys(assets).length <= 128,
  'Public asset inventory exceeds entry bound',
)
assert.ok(
  Object.values(assets).reduce((sum, asset) => sum + asset.size, 0) <=
    4 * 1024 * 1024,
  'Public asset inventory exceeds byte bound',
)
const inventory = JSON.stringify(assets)
const version = createHash('sha256')
  .update(inventory)
  .digest('hex')
  .slice(0, 24)
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
writeFileSync(
  new URL('sw.js', dist),
  source
    .replace("const BUILD = '__BUILD__'", `const BUILD = '${version}'`)
    .replace('/*__ASSETS__*/ {}', inventory),
)
console.log(
  `Public asset cache: ${Object.keys(assets).length} immutable files, version ${version}`,
)
