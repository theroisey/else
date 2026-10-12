import { useEffect, useRef, useState } from 'react'
import { copy, useLocale } from '../../i18n'
import { Button } from '../../components/ui'
import { useRecordOperations } from '../auth/useRecordOperations'
import * as api from './service'
interface Entry {
  id: string
  file: File
  uploaded: boolean
  failed: boolean
}
export function EvidenceUpload({
  client,
  onChange,
  onBusy,
  disabled = false,
}: {
  client: string
  onChange: (ids: string[]) => void
  onBusy: (busy: boolean) => void
  disabled?: boolean
}) {
  useLocale()
  const op = useRecordOperations('operations', client)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const active = useRef(false)
  const [entries, setEntries] = useState<Entry[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function upload(selected: File[]) {
    if (active.current || disabled || entries.length + selected.length > 8) {
      setError(copy('Choose up to eight files.', 'operations'))
      return
    }
    const newEntries = [
      ...entries,
      ...selected.map((file) => ({
        id: crypto.randomUUID(),
        file,
        uploaded: false,
        failed: false,
      })),
    ]
    await process(newEntries)
  }
  async function process(values: Entry[]) {
    if (active.current) return
    active.current = true
    setBusy(true)
    onBusy(true)
    setError('')
    let current = values
    setEntries(current)
    try {
      for (const item of current.filter((v) => !v.uploaded)) {
        try {
          await op.read(() => api.upload(client, item.id, item.file))
          current = current.map((v) =>
            v.id === item.id ? { ...v, uploaded: true, failed: false } : v,
          )
        } catch {
          current = current.map((v) =>
            v.id === item.id ? { ...v, failed: true } : v,
          )
          setError(
            copy(
              'Upload failed. Check the format and connection, then retry.',
              'operations',
            ),
          )
        }
        if (!mounted.current) return
        setEntries(current)
      }
      if (!mounted.current) return
      onChange(current.filter((v) => v.uploaded).map((v) => v.id))
    } finally {
      active.current = false
      if (mounted.current) {
        setBusy(false)
        onBusy(false)
      }
    }
  }
  return (
    <fieldset
      className="border-t border-line pt-5"
      disabled={disabled || busy}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files)
        if (files.length) {
          e.preventDefault()
          void upload(files)
        }
      }}
    >
      <legend className="text-sm font-medium">
        {copy('Screenshots and documents', 'operations')}
      </legend>
      <p className="my-3 text-xs leading-6 text-muted">
        {copy(
          'PNG, JPEG, WebP or PDF · 8 MiB per file · up to eight files. You can paste a screenshot here.',
          'operations',
        )}
      </p>
      <label className="ui-label" htmlFor={`evidence-${client}`}>
        {copy('Choose files', 'operations')}
      </label>
      <input
        id={`evidence-${client}`}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,application/pdf"
        className="ui-input w-full min-w-0"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          void upload(files)
        }}
      />
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger-ink">
          {error}
        </p>
      ) : null}
      <ul className="mt-4 grid gap-4 sm:grid-cols-2">
        {entries.map((v) => (
          <li key={v.id} className="min-w-0">
            <p className="break-words text-xs">
              {v.file.name} ·{' '}
              {copy(
                v.uploaded
                  ? 'Uploaded'
                  : v.failed
                    ? 'Upload failed'
                    : 'Uploading…',
                'operations',
              )}
            </p>
            {v.uploaded && v.file.type.startsWith('image/') ? (
              <img
                src={api.evidenceURL(client, v.id)}
                alt={v.file.name}
                className="mt-2 max-h-40 max-w-full rounded-sm border border-line object-contain"
                loading="lazy"
              />
            ) : null}
            <Button
              size="compact"
              disabled={disabled || busy}
              onClick={() => {
                active.current = true
                setBusy(true)
                onBusy(true)
                void op
                  .read(() => api.discard(client, v.id))
                  .then(() => {
                    if (!mounted.current) return
                    const remaining = entries.filter((e) => e.id !== v.id)
                    setEntries(remaining)
                    onChange(
                      remaining.filter((e) => e.uploaded).map((e) => e.id),
                    )
                  })
                  .catch(() => {
                    if (mounted.current)
                      setError(
                        copy(
                          'Upload failed. Check the format and connection, then retry.',
                          'operations',
                        ),
                      )
                  })
                  .finally(() => {
                    active.current = false
                    if (mounted.current) {
                      setBusy(false)
                      onBusy(false)
                    }
                  })
              }}
            >
              {copy('Remove')}
            </Button>
          </li>
        ))}
      </ul>
      {entries.some((v) => v.failed) ? (
        <Button
          className="mt-4"
          onClick={() => {
            void process(entries)
          }}
        >
          {copy('Retry uploads', 'operations')}
        </Button>
      ) : null}
    </fieldset>
  )
}
