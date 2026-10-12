import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from '../../lib/validation'
import { APIError, authenticatedJSON } from '../../services/authenticated'
import { Button, Dialog, SelectField, TextField } from '../../components/ui'
import { copy } from '../../i18n'
import { useRecordOperations } from '../auth/useRecordOperations'
import { checked, uuid, pagination, data } from './models'
import { OperationsError } from './Shared'
import { automationFailure } from './automation-models'

export function AutomationFailure({
  failure,
}: {
  failure: z.infer<typeof automationFailure>
}) {
  return failure ? (
    <div
      role="status"
      className="mt-6 border-l-2 border-warning-ink pl-4 text-sm"
    >
      <p className="font-medium">
        {copy('Automation needs attention', 'operations')}
      </p>
      <p className="mt-2">
        {copy(new APIError(0, failure.error_code).message)}
      </p>
      <p className="mt-2 text-muted">
        {copy('Next automatic retry', 'operations')}:{' '}
        {new Date(failure.retry_after).toLocaleString()}
      </p>
      <p className="mt-2 text-muted">
        {copy(
          'Check the manager’s current access, assignee, brand and schedule. Historical records remain.',
          'operations',
        )}
      </p>
    </div>
  ) : null
}
export function ManagerTransfer({
  client,
  id,
  revision,
  current,
  financial,
  close,
}: {
  client: string
  id: string
  revision: string
  current: string
  financial: boolean
  close: () => void
}) {
  const op = useRecordOperations(financial ? 'agreements' : 'recurring', client)
  const base = `/api/v1/clients/${client}/${financial ? 'agreements' : 'recurring-tasks'}`
  const [selected, setSelected] = useState('')
  const [search, setSearch] = useState('')
  const [cursor, setCursor] = useState('')
  const [locked, setLocked] = useState(false)
  const command = useRef<unknown>(null)
  const baseline = useRef(revision)
  const t = (v: string) => copy(v, 'operations')
  const q = useQuery({
    queryKey: [...op.key, 'managers', search, cursor],
    queryFn: ({ signal }) =>
      op.read(async () => {
        const params = new URLSearchParams({ limit: '25' })
        if (search.trim()) params.set('q', search.trim())
        if (cursor) params.set('cursor', cursor)
        const result = checked(
          z
            .object({
              data: z
                .array(
                  z
                    .object({ id: uuid, display_name: z.string().max(100) })
                    .strict(),
                )
                .max(25),
              page: pagination,
            })
            .strict(),
          await authenticatedJSON(`${base}/managers?${params}`, { signal }),
        )
        if (
          result.data.some(
            (v, i) =>
              (cursor && v.id <= cursor) ||
              (i > 0 && v.id <= result.data[i - 1]!.id),
          ) ||
          (result.page.next_cursor !== null &&
            result.page.next_cursor !== result.data.at(-1)?.id)
        )
          throw new APIError(0, 'invalid_response')
        return result
      }),
  })
  return (
    <Dialog
      open
      variant="drawer"
      title={t('Transfer automation responsibility')}
      description={t(
        'The new manager must have current access to this brand and the capabilities needed to generate records.',
      )}
      onClose={() => {
        if (
          !op.pending &&
          (!locked ||
            window.confirm(
              t(
                'Close this form and inspect the recorded history before starting another transaction?',
              ),
            ))
        )
          close()
      }}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!command.current) {
            command.current = {
              command_id: crypto.randomUUID(),
              expected_revision: baseline.current,
              managed_by: selected,
            }
            setLocked(true)
          }
          void op
            .run(
              async () => {
                const r = data(
                  z.object({ id: uuid, replayed: z.boolean() }).strict(),
                  await authenticatedJSON(`${base}/${id}`, {
                    method: 'PUT',
                    body: command.current,
                  }),
                )
                if (r.id !== id) throw new APIError(0, 'invalid_response')
                return r
              },
              (error) => {
                if (error instanceof APIError && error.status === 400) {
                  command.current = null
                  setLocked(false)
                }
              },
            )
            .then((r) => {
              if (r) close()
            })
        }}
      >
        <fieldset disabled={op.pending || locked} className="space-y-4">
          <TextField
            label={t('Find manager')}
            value={search}
            maxLength={100}
            onChange={(e) => {
              setSearch(e.target.value)
              setCursor('')
            }}
          />
          <SelectField
            required
            label={t('Responsible manager')}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">{t('Choose manager')}</option>
            {selected && !q.data?.data.some((v) => v.id === selected) ? (
              <option value={selected}>{t('Selected manager')}</option>
            ) : null}
            {q.data?.data
              .filter((v) => v.id !== current)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.display_name}
                </option>
              ))}
          </SelectField>
          {cursor ? (
            <Button onClick={() => setCursor('')}>{t('First page')}</Button>
          ) : null}
          {q.data?.page.next_cursor ? (
            <Button onClick={() => setCursor(q.data.page.next_cursor!)}>
              {t('Next page')}
            </Button>
          ) : null}
        </fieldset>
        {q.isError ? (
          <OperationsError
            error={q.error}
            retry={() => {
              void q.refetch()
            }}
          />
        ) : null}
        {op.error ? (
          <p role="alert" className="text-danger-ink">
            {copy(op.error)}
          </p>
        ) : null}
        {locked ? (
          <p className="text-sm text-muted">
            {t(
              'Values are held for reconciliation. Retry sends the original command only.',
            )}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={op.pending || !selected}
          variant="primary"
        >
          {t(locked ? 'Retry original command' : 'Save')}
        </Button>
      </form>
    </Dialog>
  )
}
