import { useLocale } from '../../i18n/index'
import type { ReactNode } from 'react'

type StatusTone = 'neutral' | 'success' | 'warning' | 'danger'

const tones: Record<StatusTone, string> = {
  neutral: 'text-muted',
  success: 'text-success-ink',
  warning: 'text-warning-ink',
  danger: 'text-danger-ink',
}

export function Status({
  tone = 'neutral',
  children,
}: {
  tone?: StatusTone
  children: ReactNode
}) {
  useLocale()
  return <span className={`ui-status ${tones[tone]}`}>{children}</span>
}
