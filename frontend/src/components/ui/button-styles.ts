export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'danger'
  | 'danger-ghost'
  | 'ghost'
  | 'text'
export type ButtonSize = 'compact' | 'default'

const variants: Record<ButtonVariant, string> = {
  primary: 'border-ink bg-ink text-surface not-disabled:hover:bg-ink-soft',
  secondary:
    'border-line bg-surface text-ink not-disabled:hover:border-ink not-disabled:hover:bg-surface-subtle',
  'danger-ghost':
    'border-transparent bg-transparent text-danger-ink not-disabled:hover:border-danger-line not-disabled:hover:bg-danger-surface',
  danger:
    'border-danger-strong bg-danger-strong text-on-danger not-disabled:hover:opacity-90',
  text: 'border-transparent bg-transparent text-ink underline underline-offset-4 not-disabled:hover:text-accent',
  ghost:
    'border-transparent bg-transparent text-ink not-disabled:hover:border-line not-disabled:hover:bg-surface-subtle',
}

const sizes: Record<ButtonSize, string> = {
  compact: 'ui-button-compact px-2.5 text-xs',
  default: 'ui-button-default px-3.5 text-sm',
}

export function buttonStyles({
  variant = 'secondary',
  size = 'default',
  className = '',
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
} = {}) {
  return `ui-button ${variants[variant]} ${sizes[size]} ${className}`.trim()
}
