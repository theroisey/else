import { useLocale } from '../../i18n/index'
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
  variant = 'secondary',
  size = 'default',
  icon,
  loading = false,
  loadingLabel,
  disabled,
  className = '',
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  useLocale()
  return (
    <button
      {...props}
      type={type}
      className={buttonStyles({ variant, size, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && icon ? (
        <FontAwesomeIcon
          className="size-3 motion-safe:animate-spin"
          icon={faCircleNotch}
          aria-hidden="true"
        />
      ) : icon ? (
        <FontAwesomeIcon className="size-3" icon={icon} aria-hidden="true" />
      ) : null}
      <span>{children}</span>
      {loading && loadingLabel ? (
        <span className="sr-only" role="status">
          {' '}
          {loadingLabel}
        </span>
      ) : null}
    </button>
  )
}
