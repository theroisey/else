import { requestHealthJSON } from '../../services/http'

export type Service = 'backend' | 'readiness'
export type ServiceState = 'available' | 'unavailable'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function checkService(service: Service, signal: AbortSignal): Promise<ServiceState> {
  const { status, body } = await requestHealthJSON(service === 'backend' ? '/health' : '/ready', signal)
  if (status === 200 && isRecord(body) && body.status === (service === 'backend' ? 'ok' : 'ready')) {
    return 'available'
  }
  if (service === 'readiness' && status === 503 && isRecord(body) && isRecord(body.error)
    && body.error.code === 'not_ready' && typeof body.error.request_id === 'string') {
    return 'unavailable'
  }
  throw new Error('Service check failed. Try again.')
}
