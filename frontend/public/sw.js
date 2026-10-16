/* Public, build-verified assets only. Never rewrite the network Request. */
const BUILD = '__BUILD__'
const ASSETS = /*__ASSETS__*/ {}
const PREFIX = 'roisey-else-public-assets-'
const CACHE = PREFIX + 'v2-' + BUILD
const MAX_ENTRIES = 128
const MAX_BYTES = 4 * 1024 * 1024
let writes = Promise.resolve()
let pending = 0

self.addEventListener('install', (event) => {
  // No precache waterfall, skipWaiting or automatic replacement of live tabs.
  event.waitUntil(
    BUILD === '__BUILD__'
      ? Promise.reject(new Error('Unbuilt worker'))
      : Promise.resolve(),
  )
})
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        for (const name of await caches.keys()) {
          if (name.startsWith(PREFIX) && name !== CACHE)
            await caches.delete(name)
        }
      } catch {
        /* Storage is optional; ordinary networking remains available. */
      }
    })(),
  )
})

function eligible(response, url, asset) {
  return (
    response.status === 200 &&
    !response.redirected &&
    response.url === url &&
    response.type === 'basic' &&
    response.headers.get('cf-mitigated') !== 'challenge' &&
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ===
      asset.mime &&
    /(?:^|,)\s*public(?:,|$)/i.test(
      response.headers.get('cache-control') || '',
    ) &&
    /(?:^|,)\s*immutable(?:,|$)/i.test(
      response.headers.get('cache-control') || '',
    ) &&
    !/(?:^|,)\s*(?:private|no-store|no-cache)(?:[=,]|$)/i.test(
      response.headers.get('cache-control') || '',
    )
  )
}

async function verified(response, url, asset) {
  if (!eligible(response, url, asset) || !response.body) return false
  const reader = response.clone().body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > asset.size) {
      // Cancelling a tee can wait for its other consumer; do not hold delivery.
      void reader.cancel().catch(() => {})
      return false
    }
    chunks.push(value)
  }
  if (size !== asset.size) return false
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
  return hash === asset.sha256
}

async function trim(cache) {
  const keys = await cache.keys()
  let size = 0
  const known = []
  for (const key of keys) {
    const url = new URL(key.url)
    const asset =
      url.origin === self.location.origin && !url.search && ASSETS[url.pathname]
    if (!asset) {
      await cache.delete(key)
      continue
    }
    size += asset.size
    known.push(key)
  }
  while (known.length > MAX_ENTRIES || size > MAX_BYTES) {
    const key = known.shift()
    size -= ASSETS[new URL(key.url).pathname].size
    await cache.delete(key)
  }
}

async function deliver(request, event, asset) {
  let cache
  // This header-free synthetic key belongs ONLY to Cache Storage. Real network
  // I/O below always receives the original Request and its original credentials.
  const key = new Request(request.url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  try {
    cache = await caches.open(CACHE)
    {
      const cached = await cache.match(key)
      if (cached) {
        let valid = false
        try {
          valid = await verified(cached, request.url, asset)
        } finally {
          if (!valid) void cached.body?.cancel().catch(() => {})
        }
        if (valid) return cached
        await cache.delete(key)
      }
    }
  } catch {
    /* Cache failures must never prevent the real request. */
  }
  const response = await fetch(request)
  // Bound verification work and retain no bodies for unrelated/private requests.
  if (
    cache &&
    request.cache !== 'no-store' &&
    eligible(response, request.url, asset) &&
    pending < 4
  ) {
    pending++
    const candidate = response.clone()
    const store = writes
      .then(async () => {
        try {
          if (await verified(candidate, request.url, asset)) {
            await cache.put(key, candidate)
            await trim(cache)
          }
        } finally {
          // Release rejected tee branches so a large challenge/error body cannot
          // continue buffering while the browser consumes its network response.
          if (!candidate.bodyUsed) void candidate.body?.cancel().catch(() => {})
        }
      })
      .catch(() => {
        /* Quota/storage/network failures cannot poison the cache. */
      })
      .finally(() => {
        pending--
      })
    writes = store
    event.waitUntil(store)
  }
  return response
}
self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  const asset =
    url.origin === self.location.origin && !url.search && ASSETS[url.pathname]
  if (
    request.method !== 'GET' ||
    request.headers.has('authorization') ||
    request.headers.has('range') ||
    ['reload', 'no-cache', 'no-store'].includes(request.cache) ||
    !['', 'script', 'style', 'font'].includes(request.destination) ||
    !asset
  )
    return
  event.respondWith(deliver(request, event, asset))
})
