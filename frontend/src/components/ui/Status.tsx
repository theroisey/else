import type { ReactNode } from 'react'

type StatusTone = 'neutral' | 'success' | 'warning' | 'danger'

const tones: Record<StatusTone, string> = {
  neutral: 'border-line bg-surface-subtle text-ink-soft',
  success: 'border-success-line bg-success-surface text-success-ink',
  warning: 'border-warning-line bg-warning-surface text-warning-ink',
  danger: 'border-danger-line bg-danger-surface text-danger-ink',
}

export function Status({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={`ui-status ${tones[tone]}`}>{children}</span>
}
