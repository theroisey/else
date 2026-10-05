import { forwardRef, useId } from 'react'
import type { SelectHTMLAttributes } from 'react'
import { copy, useLocale } from '../../i18n'

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string
  description?: string
  error?: string
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(
  function SelectField(
    {
      label,
      description,
      error,
      id,
      children,
      className = '',
      'aria-describedby': extra,
      ...props
    },
    ref,
  ) {
    useLocale()
    const generated = useId()
    const controlID = id ?? generated
    const helpID = description ? `${controlID}-description` : undefined
    const errorID = error ? `${controlID}-error` : undefined
    return (
      <div className="ui-field">
        <label className="ui-label" htmlFor={controlID}>
          {copy(label)}
        </label>
        <div className="ui-field-body">
          <select
            {...props}
            id={controlID}
            ref={ref}
            className={`ui-input ${error ? 'border-danger-strong' : ''} ${className}`.trim()}
            aria-invalid={error ? true : props['aria-invalid']}
            aria-describedby={
              [extra, helpID, errorID].filter(Boolean).join(' ') || undefined
            }
          >
            {children}
          </select>
          {description ? (
            <p id={helpID} className="text-xs leading-5 text-muted">
              {copy(description)}
            </p>
          ) : null}
          {error ? (
            <p
              id={errorID}
              role="alert"
              className="text-xs font-medium text-danger-ink"
            >
              {copy(error)}
            </p>
          ) : null}
        </div>
      </div>
    )
  },
)
