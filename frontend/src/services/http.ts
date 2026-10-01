export type HealthPath = '/health' | '/ready'

// Only fixed, same-origin public health paths are accepted in this slice.
// Business transport and authentication are defined by their own Issues.
export async function requestHealthJSON(path: HealthPath, signal: AbortSignal) {
  try {
    const response = await fetch(path, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    })
    if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new Error('Invalid service response.')
    }
    const body: unknown = await response.json()
    return { status: response.status, body }
  } catch {
    // Raw network errors and server bodies can contain sensitive details.
    throw new Error('Service check failed. Try again.')
  }
}
