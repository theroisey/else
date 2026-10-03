import { Link } from 'react-router'
import { useReleaseReport } from './useReleaseReport'

export function ReleaseIndicator() {
  const { allowed, query } = useReleaseReport()
  if (!allowed) return null
  const runtime = !query.isError && !query.isFetching ? query.data?.runtime : undefined
  const label = query.isFetching ? 'Checking build…' : runtime?.status === 'available' ? `API ${runtime.commit_sha.slice(0, 7)}` : 'Build unavailable'
  return <Link to="/app/releases" aria-label={`Release Center: ${label}`} className="hidden max-w-40 truncate text-xs text-muted underline underline-offset-4 sm:inline">{label}</Link>
}
