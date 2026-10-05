import { copy, useLocale } from '../../i18n/index'
import { Link } from 'react-router'
import { useReleaseReport } from './useReleaseReport'

export function ReleaseIndicator() {
  useLocale()
  const { allowed, query } = useReleaseReport()
  if (!allowed) return null
  const runtime =
    !query.isError && !query.isFetching ? query.data?.runtime : undefined
  const label = query.isFetching
    ? copy('Checking build…', 'releases')
    : runtime?.status === 'available'
      ? `API ${runtime.commit_sha.slice(0, 7)}`
      : copy('Build unavailable', 'releases')
  return (
    <Link
      to="/app/releases"
      aria-label={copy('Release Center: {{value1}}', 'releases', {
        value1: label,
      })}
      className="hidden max-w-40 truncate text-xs text-muted underline underline-offset-4 sm:inline"
    >
      {label}
    </Link>
  )
}
