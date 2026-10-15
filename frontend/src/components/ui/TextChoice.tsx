import { useEffect, useRef, useState } from 'react'
import { Dialog } from './Dialog'

/** Quiet preference trigger; the shared dialog provides focus trapping and Escape. */
export function TextChoice<T extends string>({
  label,
  description,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string
  description: string
  value: T
  options: readonly { value: T; label: string; lang?: string }[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const restore = useRef(false)
  useEffect(() => {
    if (!open && !disabled && restore.current) {
      restore.current = false
      trigger.current?.focus()
    }
  }, [open, disabled])
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="preference-text-button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span>{label}</span>
        <span className="text-ink">
          {options.find((option) => option.value === value)?.label}
        </span>
      </button>
      <Dialog
        open={open}
        title={label}
        description={description}
        eyebrow="Roisey Else"
        onClose={() => setOpen(false)}
      >
        <div className="preference-choices">
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              lang={option.lang}
              aria-pressed={option.value === value}
              disabled={disabled}
              onClick={() => {
                restore.current = true
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Dialog>
    </>
  )
}
