import { copy, useLocale } from '../../i18n/index'
import type { ReactNode } from 'react'
import { Button, Dialog, PageHeader as Header } from '../../components/ui'
import type { Page } from './models'
import type { useCursor } from './hooks'
import { AdministrationError } from './service'

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: ReactNode
}) {
  useLocale()
  return (
    <Header
      eyebrow={copy('Administration', 'administration')}
      title={title}
      description={description}
    >
      {children}
    </Header>
  )
}
export function ErrorState({
  error,
  retry,
}: {
  error: unknown
  retry: () => void
}) {
  useLocale()
  return (
    <div className="my-4 rounded-md border border-danger-line bg-danger-surface p-4">
      <p role="alert">
        {error instanceof AdministrationError
          ? copy(error.message, 'administration')
          : copy('Unable to load current data. Try again.', 'administration')}
      </p>
      <Button className="mt-3" onClick={retry}>
        {copy('Try again', 'administration')}
      </Button>
    </div>
  )
}
export function Pager({
  page,
  cursor,
  busy,
  label = copy('Table pagination', 'administration'),
}: {
  label?: string
  page?: Page<unknown> | undefined
  cursor: ReturnType<typeof useCursor>
  busy: boolean
}) {
  useLocale()
  return (
    <nav
      className="mt-4 flex flex-wrap items-center justify-between gap-3"
      aria-label={label}
    >
      <p className="text-xs text-muted">
        {copy('Up to 25 records per page', 'administration')}
      </p>
      <div className="flex gap-2">
        <Button
          size="compact"
          disabled={!cursor.previous || busy}
          onClick={cursor.back}
        >
          {copy('Previous', 'administration')}
        </Button>
        <Button
          size="compact"
          disabled={!page?.page.next_cursor || busy}
          onClick={() => {
            if (page?.page.next_cursor) cursor.next(page.page.next_cursor)
          }}
        >
          {copy('Next', 'administration')}
        </Button>
      </div>
    </nav>
  )
}
export function Confirmation({
  title,
  description,
  pending,
  error,
  onCancel,
  onConfirm,
  label = copy('Confirm', 'administration'),
  disabled = false,
}: {
  title: string
  description: string
  pending: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
  label?: string
  disabled?: boolean
}) {
  useLocale()
  return (
    <Dialog
      open
      title={title}
      description={description}
      onClose={() => {
        if (!pending) onCancel()
      }}
    >
      {error ? (
        <p className="mt-4 text-danger-ink" role="alert">
          {copy(error, 'administration')}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button disabled={pending} onClick={onCancel}>
          {copy('Cancel', 'administration')}
        </Button>
        <Button
          variant="danger"
          disabled={disabled}
          loading={pending}
          loadingLabel={copy('Saving', 'administration')}
          onClick={onConfirm}
        >
          {label}
        </Button>
      </div>
    </Dialog>
  )
}
export function PermissionChoices({
  catalog,
  selected,
  onChange,
  allowed,
  disabled = false,
}: {
  catalog: readonly { permission: string; description: string }[]
  selected: string[]
  onChange: (keys: string[]) => void
  allowed: (key: string) => boolean
  disabled?: boolean
}) {
  useLocale()
  return (
    <fieldset
      disabled={disabled}
      className="grid max-h-64 gap-2 overflow-y-auto rounded-md border border-line p-3"
    >
      <legend className="px-1 font-semibold">
        {copy('Permissions', 'administration')}
      </legend>
      {catalog.map((p) => (
        <label className="flex items-start gap-3 py-1" key={p.permission}>
          <input
            type="checkbox"
            className="mt-1 size-4 accent-ink"
            checked={selected.includes(p.permission)}
            disabled={!allowed(p.permission)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, p.permission]
                  : selected.filter((key) => key !== p.permission),
              )
            }
          />
          <span>
            <span className="block font-mono text-xs">{p.permission}</span>
            <span className="mt-1 block text-xs text-muted">
              {copy(p.description, 'administration')}
              {!allowed(p.permission)
                ? copy(' · Requires global control', 'administration')
                : ''}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}
