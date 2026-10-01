import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faCircleNotch } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { buttonStyles } from './button-styles'
import type { ButtonSize, ButtonVariant } from './button-styles'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconDefinition
  loading?: boolean
  loadingLabel?: string
  children: ReactNode
}

export function Button({
  variant = 'secondary', size = 'default', icon, loading = false,
  loadingLabel, disabled, className = '', children, type = 'button', ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={buttonStyles({ variant, size, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading
        ? <FontAwesomeIcon className="motion-safe:animate-spin" icon={faCircleNotch} aria-hidden="true" />
        : icon ? <FontAwesomeIcon icon={icon} aria-hidden="true" /> : null}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
    </button>
  )
}
