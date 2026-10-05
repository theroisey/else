import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '../../components/ui'
import { recordKey, terminal } from './models'
import type { RecordData } from './models'
import { CandidatePicker } from './CandidatePicker'
import { LinkHistory } from './LinkHistory'
import type { Operation } from './Shared'
import * as api from './service'

export function TaskLinks({
  record,
  operation,
  checking = false,
  onEditingChange,
}: {
  record: RecordData
  operation: Operation
  checking?: boolean
  onEditingChange: (editing: boolean) => void
}) {
  const { scope, permissions } = operation
  const [editing, setEditing] = useState(false),
    [selected, setSelected] = useState(record.task_ids ?? []),
    [revision, setRevision] = useState(record.revision),
    [reloading, setReloading] = useState(false),
    [reloadError, setReloadError] = useState(''),
    [notice, setNotice] = useState('')
  const editable =
    permissions.update &&
    operation.writable &&
    !checking &&
    !record.archived_at &&
    !terminal(record.status)
  const conflict = editing && (record.revision !== revision || operation.errorCode === 'conflict')
  const busy = operation.pending || reloading
  const retained = selected.filter((id) => record.task_ids?.includes(id))
  const added = selected.filter((id) => !record.task_ids?.includes(id))
  const cannotAdd = !permissions.taskView && added.length > 0
  async function reload() {
    if (busy) return
    setReloading(true)
    setReloadError('')
    try {
      const current = await operation.read(() => api.detail(scope, record.id))
      operation.cache.setQueryData([...operation.key, ...recordKey(scope, record.id)], current)
      setSelected(current.task_ids ?? [])
      setRevision(current.revision)
      operation.clearError()
      await operation.parent.refetch()
    } catch {
      setReloadError('Unable to reload task references. Try again.')
    } finally {
      setReloading(false)
    }
  }
  return (
    <section className="mt-6 min-w-0 form-section">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Linked tasks</h2>
          <p className="mt-2 text-xs text-muted">
            References preserve history and never change task status. Task details require separate
            access.
          </p>
        </div>
        {editable && !editing ? (
          <Button
            onClick={() => {
              setSelected(record.task_ids ?? [])
              setRevision(record.revision)
              setNotice('')
              operation.clearError()
              setEditing(true)
              onEditingChange(true)
            }}
          >
            Edit task links
          </Button>
        ) : null}
      </div>
      {notice ? (
        <p role="status" className="mt-3">
          {notice}
        </p>
      ) : null}
      {!editing ? (
        <ReferenceList ids={record.task_ids ?? []} operation={operation} />
      ) : (
        <>
          <fieldset disabled={!editable || busy} className="mt-4 grid min-w-0 gap-3">
            <legend className="font-semibold">
              Selected task references · {selected.length}/50
            </legend>
            <p className="text-xs text-muted">
              Keep unavailable existing references or remove them explicitly. Saving replaces the
              complete selection.
            </p>
            <ReferenceList
              ids={selected}
              operation={operation}
              remove={(id) => setSelected((ids) => ids.filter((v) => v !== id))}
            />
            {permissions.taskView ? (
              <CandidatePicker
                operation={operation}
                selected={selected}
                onChange={setSelected}
                disabled={!editable || busy}
              />
            ) : (
              <p role="status" className="text-sm text-muted">
                Task access is unavailable. You can retain or remove existing references; new tasks
                cannot be selected.
              </p>
            )}
          </fieldset>
          {!editable ? (
            <p role="status" className="mt-3">
              Link changes are unavailable for this record or its parent. Your selection is
              preserved.
            </p>
          ) : null}
          {cannotAdd ? (
            <p role="alert" className="mt-3">
              Task access changed. Remove new selections before saving retained references.
            </p>
          ) : null}
          {operation.error ? (
            <p role="alert" className="mt-3 text-danger-ink">
              {operation.error}
            </p>
          ) : null}
          {conflict ? (
            <div className="mt-3">
              <p role="alert">
                The milestone changed. Your selection is preserved. Reloading discards it and uses
                current references.
              </p>
              <Button
                className="mt-2"
                disabled={busy}
                onClick={() => {
                  void reload()
                }}
              >
                Reload task references
              </Button>
            </div>
          ) : null}
          {reloadError ? (
            <p role="alert" className="mt-3 text-danger-ink">
              {reloadError}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={busy}
              loadingLabel="Saving task links"
              disabled={!editable || conflict || cannotAdd}
              onClick={() => {
                void operation
                  .run(() => api.replaceLinks(scope, record.id, selected, revision))
                  .then((result) => {
                    if (result) {
                      setEditing(false)
                      onEditingChange(false)
                      setNotice('Task links saved.')
                    }
                  })
              }}
            >
              Save task links
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setEditing(false)
                onEditingChange(false)
                setSelected(retained)
                operation.clearError()
              }}
            >
              Cancel link editing
            </Button>
          </div>
        </>
      )}
      <LinkHistory operation={operation} recordID={record.id} />
    </section>
  )
}
function ReferenceList({
  ids,
  operation,
  remove,
}: {
  ids: string[]
  operation: Operation
  remove?: (id: string) => void
}) {
  return ids.length ? (
    <ul aria-label="Task references" className="mt-3 grid gap-2">
      {ids.map((id) => (
        <li
          key={id}
          className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-sm border border-line p-3"
        >
          <span className="min-w-0 break-all text-xs">
            {operation.permissions.taskView ? (
              <Link
                className="underline underline-offset-4"
                to={`/app/clients/${operation.scope.clientID}/tasks/${id}`}
              >
                Task {id}
              </Link>
            ) : (
              <>Task reference {id}</>
            )}
          </span>
          {remove ? (
            <Button
              size="compact"
              aria-label={`Remove task reference ${id}`}
              onClick={() => remove(id)}
            >
              Remove
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  ) : (
    <p className="mt-3 text-sm text-muted">No task references selected.</p>
  )
}
