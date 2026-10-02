import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'

const focusableSelector = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])',
].join(',')

export function Dialog({ open, title, description, children, onClose, eyebrow = 'Confirmation' }: {
  open: boolean
  title: string
  description: string
  children: ReactNode
  onClose: () => void
  eyebrow?: string
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleID = useId()
  const descriptionID = useId()

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    }
    const first = dialog.querySelector<HTMLElement>(focusableSelector)
    const initialFocus = first ?? dialog
    initialFocus.focus()

    return () => {
      document.body.style.overflow = previousOverflow
      if (dialog.open && typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
      previousFocus?.focus()
    }
  }, [open])

  if (!open) return null

  function keepFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  function dismissBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) onClose()
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="ui-dialog"
      aria-labelledby={titleID}
      aria-describedby={descriptionID}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onKeyDown={keepFocus}
      onMouseDown={dismissBackdrop}
      tabIndex={-1}
    >
      <div className="ui-dialog-panel">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2 className="mt-2 text-lg font-semibold tracking-tight" id={titleID}>{title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted" id={descriptionID}>{description}</p>
        </div>
        {children}
      </div>
    </dialog>,
    document.body,
  )
}
