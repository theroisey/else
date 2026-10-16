import assert from 'node:assert/strict'
import { webcrypto, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const origin = 'https://synthetic.invalid'
const prefix = 'roisey-else-public-assets-v2-'
const path = '/assets/synthetic-12345678.js'
const body = '/* synthetic public code */'
const metadata = (text) => ({
  mime: 'text/javascript',
  size: Buffer.byteLength(text),
  sha256: createHash('sha256').update(text).digest('hex'),
})
function response(
  text = body,
  {
    status = 200,
    type = 'basic',
    url = origin + path,
    redirected = false,
    headers = {},
  } = {},
) {
  const value = new Response(text, {
    status,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      ...headers,
    },
  })
  const decorate = (target) => {
    const clone = target.clone.bind(target)
    Object.defineProperties(target, {
      type: { value: type },
      url: { value: url },
      redirected: { value: redirected },
      clone: { value: () => decorate(clone()) },
    })
    return target
  }
  return decorate(value)
}
function fixture({
  assets = { [path]: metadata(body) },
  failStorage = false,
  failPut = false,
} = {}) {
  const listeners = new Map()
  const stored = new Map()
  const buckets = new Map([
    [prefix + 'test', stored],
    ['unrelated-cache', new Map()],
    [prefix + 'obsolete', new Map()],
    ['roisey-else-public-assets-v1', new Map()],
  ])
  const network = []
  const cacheRequests = []
  let next = () => response()
  const context = {
    self: {
      location: { origin },
      addEventListener: (type, callback) => listeners.set(type, callback),
    },
    URL,
    Request,
    Uint8Array,
    crypto: webcrypto,
    caches: {
      keys: async () => {
        if (failStorage) throw Error('Synthetic storage denied')
        return [...buckets.keys()]
      },
      delete: async (key) => buckets.delete(key),
      open: async (name) => {
        if (failStorage) throw Error('Synthetic storage denied')
        const entries = buckets.get(name)
        return {
          match: async (key) => entries.get(key.url)?.clone(),
          put: async (key, value) => {
            if (failPut) throw Error('Synthetic quota')
            cacheRequests.push(key)
            entries.set(key.url, value.clone())
          },
          delete: async (key) => entries.delete(key.url),
          keys: async () => [...entries.keys()].map((url) => new Request(url)),
        }
      },
    },
    fetch: async (request) => {
      network.push(request)
      return next(request)
    },
  }
  const source = readFileSync(
    new URL('../public/sw.js', import.meta.url),
    'utf8',
  )
    .replace("const BUILD = '__BUILD__'", "const BUILD = 'test'")
    .replace('/*__ASSETS__*/ {}', JSON.stringify(assets))
  runInNewContext(source, context)
  return {
    stored,
    buckets,
    network,
    cacheRequests,
    setNetwork: (handler) => {
      next = handler
    },
    dispatch: async (type, request) => {
      const waits = []
      let result
      listeners.get(type)({
        request,
        waitUntil: (promise) => waits.push(promise),
        respondWith: (promise) => {
          result = promise
        },
      })
      const output = await result
      await Promise.all(waits)
      return output
    },
  }
}

test('preserves the original network Request and serves verified public code from cache', async () => {
  const f = fixture()
  const request = new Request(origin + path, {
    credentials: 'include',
    headers: { 'X-Synthetic-Private': 'synthetic-private-header' },
  })
  Object.defineProperty(request, 'destination', { value: 'script' })
  assert.equal(await (await f.dispatch('fetch', request)).text(), body)
  assert.equal(f.network[0].credentials, 'include')
  assert.equal(f.network[0], request)
  assert.equal(f.cacheRequests[0].credentials, 'omit')
  assert.equal([...f.cacheRequests[0].headers].length, 0)
  f.setNetwork(() => {
    throw Error('Synthetic offline')
  })
  assert.equal(await (await f.dispatch('fetch', request)).text(), body)
  assert.equal(f.network.length, 1)
  assert.equal(
    await f.dispatch(
      'fetch',
      new Request(origin + path, {
        headers: { Authorization: 'Bearer synthetic-test-credential' },
      }),
    ),
    undefined,
  )
  for (const url of [
    '/api/v1/auth/session',
    '/login',
    '/app/clients',
    '/startup.js',
    '/assets/theme-init.js',
    path + '?variant=1',
    'https://another.invalid' + path,
  ]) {
    assert.equal(
      await f.dispatch('fetch', new Request(new URL(url, origin))),
      undefined,
    )
  }
  assert.equal(
    await f.dispatch(
      'fetch',
      new Request(origin + path, { headers: { range: 'bytes=0-8' } }),
    ),
    undefined,
  )
  assert.equal(
    await f.dispatch(
      'fetch',
      new Request(origin + path, { method: 'POST', body: 'synthetic' }),
    ),
    undefined,
  )
  assert.equal(f.network.length, 1)
})

test('rejects challenge, error, redirected, private, wrong-MIME and mismatched assets without cache poisoning', async () => {
  const candidates = [
    ...[401, 403, 404, 429, 500, 503].map((status) =>
      response('synthetic failure', { status }),
    ),
    response('<html>challenge</html>', {
      headers: { 'content-type': 'text/html' },
    }),
    response(body, { redirected: true }),
    response(body, { url: origin + '/login' }),
    response(body, { headers: { 'cf-mitigated': 'challenge' } }),
    response(body, { headers: { 'cache-control': 'private, no-store' } }),
    response(body, { headers: { 'cache-control': 'public' } }),
    response('/* wrong deployment */'),
    response(body.repeat(3)),
  ]
  for (const candidate of candidates) {
    const f = fixture()
    f.setNetwork(() => candidate)
    assert.equal(
      await f.dispatch('fetch', new Request(origin + path)),
      candidate,
    )
    assert.equal(f.stored.size, 0)
    assert.equal(f.network.length, 1)
  }
  const f = fixture()
  const request = new Request(origin + path)
  await f.dispatch('fetch', request)
  f.setNetwork(() => {
    throw Error('Synthetic network failure')
  })
  assert.equal(
    await f.dispatch('fetch', new Request(origin + path, { cache: 'reload' })),
    undefined,
  )
  assert.equal(await (await f.dispatch('fetch', request)).text(), body)
  assert.equal(f.stored.size, 1)
})

test('storage denial and quota failure leave normal networking functional', async () => {
  for (const options of [{ failStorage: true }, { failPut: true }]) {
    const f = fixture(options)
    const request = new Request(origin + path, { credentials: 'same-origin' })
    assert.equal(await (await f.dispatch('fetch', request)).text(), body)
    assert.equal(f.network[0], request)
    assert.equal(f.stored.size, 0)
  }
})

test('installation does not prefetch or replace live clients and activation removes only owned obsolete caches', async () => {
  const f = fixture()
  await f.dispatch('install')
  assert.equal(f.network.length, 0)
  await f.dispatch('activate')
  assert.deepEqual(
    [...f.buckets.keys()].sort(),
    [prefix + 'test', 'unrelated-cache'].sort(),
  )
})

test('cache writes evict oldest entries within count and byte limits', async () => {
  for (const [count, text] of [
    [129, body],
    [6, 'x'.repeat(800_000)],
  ]) {
    const assets = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `/assets/synthetic-${index}.js`,
        metadata(text),
      ]),
    )
    const f = fixture({ assets })
    for (const key of Object.keys(assets).slice(0, -1))
      f.stored.set(origin + key, response(text, { url: origin + key }))
    const last = Object.keys(assets).at(-1)
    f.setNetwork(() => response(text, { url: origin + last }))
    await f.dispatch('fetch', new Request(origin + last))
    assert.ok(f.stored.size <= 128)
    assert.ok(f.stored.size * Buffer.byteLength(text) <= 4 * 1024 * 1024)
    assert.ok(!f.stored.has(origin + Object.keys(assets)[0]))
    assert.ok(f.stored.has(origin + last))
  }
})
