export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
export type ButtonSize = 'compact' | 'default'

const variants: Record<ButtonVariant, string> = {
  primary: 'border-ink bg-ink text-surface hover:bg-ink-soft',
  secondary: 'border-line-strong bg-surface text-ink hover:border-ink hover:bg-surface-subtle',
  danger: 'border-danger-strong bg-danger-strong text-white hover:bg-danger-ink',
  ghost: 'border-transparent bg-transparent text-ink hover:border-line hover:bg-surface-subtle',
}

const sizes: Record<ButtonSize, string> = {
  compact: 'min-h-8 px-2.5 py-1.5 text-xs',
  default: 'min-h-10 px-3.5 py-2 text-sm',
}

export function buttonStyles({ variant = 'secondary', size = 'default', className = '' }: {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
} = {}) {
  return `ui-button ${variants[variant]} ${sizes[size]} ${className}`.trim()
}
