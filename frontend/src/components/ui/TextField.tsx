import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes } from 'react'

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  description?: string
  error?: string
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, description, error, id, className = '', 'aria-describedby': extraDescription, 'aria-invalid': invalid, ...props }, ref,
) {
  const generatedID = useId()
  const inputID = id ?? generatedID
  const descriptionID = description ? `${inputID}-description` : undefined
  const errorID = error ? `${inputID}-error` : undefined
  const describedBy = [extraDescription, descriptionID, errorID].filter(Boolean).join(' ') || undefined

  return (
    <div className="grid gap-1.5">
      <label className="text-sm font-semibold text-ink" htmlFor={inputID}>{label}</label>
      {description ? <p className="text-xs leading-5 text-muted" id={descriptionID}>{description}</p> : null}
      <input
        {...props}
        ref={ref}
        id={inputID}
        className={`ui-input ${error ? 'border-danger-strong' : ''} ${className}`.trim()}
        aria-describedby={describedBy}
        aria-invalid={error ? 'true' : invalid}
      />
      {error ? <p className="text-xs font-medium text-danger-ink" id={errorID} role="alert">{error}</p> : null}
    </div>
  )
})
