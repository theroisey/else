import { copy, useLocale } from '../../i18n/index'
import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes } from 'react'

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  description?: string
  error?: string
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(
    {
      label: sourceLabel,
      description: sourceDescription,
      error: sourceError,
      id,
      className = '',
      'aria-describedby': extraDescription,
      'aria-invalid': invalid,
      ...props
    },
    ref,
  ) {
    useLocale()
    const label = copy(sourceLabel)
    const description = sourceDescription ? copy(sourceDescription) : undefined
    const error = sourceError ? copy(sourceError) : undefined
    const generatedID = useId()
    const inputID = id ?? generatedID
    const descriptionID = description ? `${inputID}-description` : undefined
    const errorID = error ? `${inputID}-error` : undefined
    const describedBy =
      [extraDescription, descriptionID, errorID].filter(Boolean).join(' ') ||
      undefined

    return (
      <div className="ui-field">
        <label className="ui-label" htmlFor={inputID}>
          {label}
        </label>
        <div className="ui-field-body">
          <input
            {...props}
            ref={ref}
            id={inputID}
            className={`ui-input ${error ? 'border-danger-strong' : ''} ${className}`.trim()}
            aria-describedby={describedBy}
            aria-invalid={error ? 'true' : invalid}
          />
          {description ? (
            <p className="text-xs leading-5 text-muted" id={descriptionID}>
              {description}
            </p>
          ) : null}
          {error ? (
            <p
              className="text-xs font-medium text-danger-ink"
              id={errorID}
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>
    )
  },
)
