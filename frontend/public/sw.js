// Public, immutable build assets only. Documents and private requests bypass this worker.
const CACHE_PREFIX = 'roisey-else-public-assets-'
const CACHE_NAME = `${CACHE_PREFIX}v1`
const MAX_ENTRIES = 64
const MAX_ENTRY_BYTES = 1024 * 1024
const MAX_PENDING_WRITES = 8
const ASSET_PATH = /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(js|css|woff2?|ttf)$/
const CONTENT_TYPES = {
  js: ['text/javascript', 'application/javascript'],
  css: ['text/css'],
  woff: ['font/woff'],
  woff2: ['font/woff2'],
  ttf: ['font/ttf'],
}
let pendingWrites = 0
let writes = Promise.resolve()

// Use the normal waiting lifecycle. Never replace a worker underneath open drafts.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    )).catch(() => {
      // Cache Storage can be unavailable; network access remains usable.
    }),
  )
})

async function readBoundedBody(response) {
  const reader = response.body?.getReader()
  if (!reader) return
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return new Blob(chunks)
      bytes += value.byteLength
      if (bytes > MAX_ENTRY_BYTES) {
        void reader.cancel().catch(() => {})
        return
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

function queueWrite(key, response) {
  if (pendingWrites >= MAX_PENDING_WRITES) return Promise.resolve()
  pendingWrites++
  const copy = response.clone()
  // Serialize eviction and writes so simultaneous asset loads cannot exceed the cap.
  writes = writes.then(async () => {
    const body = await readBoundedBody(copy)
    if (!body) return
    const cache = await caches.open(CACHE_NAME)
    await cache.delete(key)
    const keys = await cache.keys()
    for (const oldest of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES + 1))) {
      await cache.delete(oldest)
    }
    const headers = new Headers(copy.headers)
    // Fetch decoded the body; encoded lengths and gzip metadata no longer describe it.
    headers.delete('content-encoding')
    headers.delete('content-length')
    await cache.put(key, new Response(body, { headers }))
  }).catch(() => {
    // Quota and storage failures must not turn a successful network read into an error.
  }).finally(() => { pendingWrites-- })
  return writes
}

async function loadAsset(request, extension) {
  // Never persist request headers, referrers, cookies or authorization in cache keys.
  const key = new Request(request.url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
  try {
    const cached = await (await caches.open(CACHE_NAME)).match(key)
    if (cached) return { response: cached }
  } catch {
    // Fall back to one network GET if cache access is denied.
  }
  const response = await fetch(new Request(request, { credentials: 'omit' }))
  const directives = (response.headers.get('cache-control') ?? '').toLowerCase()
    .split(',').map((part) => part.trim().split('=')[0])
  const contentType = response.headers.get('content-type')?.split(';')[0].trim()
  const declaredSize = Number(response.headers.get('content-length') ?? '0')
  if (
    response.status === 200 && response.type === 'basic' &&
    !response.redirected && response.url === request.url &&
    directives.includes('public') && directives.includes('immutable') &&
    !directives.some((value) => ['private', 'no-store', 'no-cache'].includes(value)) &&
    CONTENT_TYPES[extension].includes(contentType) &&
    Number.isFinite(declaredSize) && declaredSize >= 0 && declaredSize <= MAX_ENTRY_BYTES
  ) return { response, write: queueWrite(key, response) }
  return { response }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  const match = ASSET_PATH.exec(url.pathname)
  if (
    request.method !== 'GET' ||
    !['script', 'style', 'font'].includes(request.destination) ||
    ['no-store', 'no-cache', 'reload'].includes(request.cache) ||
    url.origin !== self.location.origin || url.search || url.username || url.password ||
    request.headers.has('authorization') || request.headers.has('range') || !match
  ) return

  const result = loadAsset(request, match[1])
  event.respondWith(result.then(({ response }) => response))
  event.waitUntil(result.then(({ write }) => write).catch(() => {}))
})
