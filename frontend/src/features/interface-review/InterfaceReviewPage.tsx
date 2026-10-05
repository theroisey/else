import { copy, useLocale } from '../../i18n/index'
import { Brand } from '../../components/brand/Brand'
import { AppearanceControl } from '../appearance/Appearance'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { faRotateLeft, faSave } from '@fortawesome/free-solid-svg-icons'
import { Link } from 'react-router'
import {
  Button,
  Dialog,
  Status,
  Table,
  TextField,
  buttonStyles,
} from '../../components/ui'

const inventory = [
  ['Button', 'Actions and form submission', 'Ready'],
  ['Text field', 'Labels, guidance, validation', 'Ready'],
  ['Status', 'Text-backed semantic state', 'Ready'],
  ['Table', 'Dense, responsive records', 'Ready'],
  ['Dialog', 'Confirmed destructive actions', 'Ready'],
] as const

export function InterfaceReviewPage() {
  useLocale()
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState<{
    source: string
    value?: string
  } | null>(null)
  const [resetOpen, setResetOpen] = useState(false)

  function validate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!label.trim()) {
      setError('Enter a review label before saving this local example.')
      setMessage(null)
      return
    }
    setError('')
    setMessage({
      source: '“{{value}}” is valid for this local component review.',
      value: label.trim(),
    })
  }

  function reset() {
    setLabel('')
    setError('')
    setMessage({
      source:
        'The local review example was reset. No application data changed.',
    })
    setResetOpen(false)
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Brand />
          <Link
            className={buttonStyles({ variant: 'ghost', size: 'compact' })}
            to="/service-status"
          >
            <span aria-hidden="true">←</span>
            {copy('Service status', 'common')}{' '}
          </Link>
        </div>
        <div className="mx-auto max-w-6xl px-6 pb-4">
          <AppearanceControl />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="grid gap-4 border-b border-line pb-8 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <p className="eyebrow">{copy('Interface foundation', 'common')}</p>
            <h1 className="page-title">
              {copy('Compact, clear, operational.', 'common')}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
              {copy(
                'A bounded review surface for shared controls. Examples use local UI state only and contain no client, credential, or business data.',
                'common',
              )}
            </p>
          </div>
          <Status>{copy('Internal review', 'common')}</Status>
        </div>

        <div className="review-grid mt-6">
          <section className="review-card" aria-labelledby="form-review-title">
            <p className="eyebrow">{copy('Form controls', 'common')}</p>
            <h2 className="mt-2 text-lg font-semibold" id="form-review-title">
              {copy('Label validation', 'common')}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {copy(
                'Submit an in-memory label to review help, error, success, and button states.',
                'common',
              )}
            </p>
            <form
              className="field-grid mt-5 grid gap-4"
              onSubmit={validate}
              noValidate
            >
              <TextField
                label={copy('Review label', 'common')}
                description={copy(
                  'Local component example; nothing is sent to the backend.',
                  'common',
                )}
                error={copy(error, 'common')}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={copy('Example label', 'common')}
                autoComplete="off"
              />
              <TextField
                label={copy('Disabled field', 'common')}
                description={copy(
                  'This control demonstrates an unavailable input.',
                  'common',
                )}
                value={copy('Unavailable example', 'common')}
                disabled
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" icon={faSave}>
                  {copy('Validate label', 'common')}
                </Button>
                <Button
                  variant="danger"
                  icon={faRotateLeft}
                  onClick={() => setResetOpen(true)}
                >
                  {copy('Reset example', 'common')}
                </Button>
                <Button disabled>{copy('Disabled action', 'common')}</Button>
              </div>
              {message ? (
                <p className="text-sm text-success-ink" role="status">
                  {copy(message.source, 'common', { value: message.value })}
                </p>
              ) : null}
            </form>
          </section>

          <section
            className="review-card"
            aria-labelledby="status-review-title"
          >
            <p className="eyebrow">{copy('Semantic state', 'common')}</p>
            <h2 className="mt-2 text-lg font-semibold" id="status-review-title">
              {copy('Status treatments', 'common')}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {copy(
                'Meaning is always written. Color only reinforces the label.',
                'common',
              )}
            </p>
            <div
              className="mt-5 flex flex-wrap gap-2"
              aria-label={copy('Status examples', 'common')}
            >
              <Status>{copy('Neutral', 'common')}</Status>
              <Status tone="success">{copy('Ready', 'common')}</Status>
              <Status tone="warning">{copy('Attention', 'common')}</Status>
              <Status tone="danger">{copy('Blocked', 'common')}</Status>
            </div>
            <div className="mt-6 rounded-sm border border-line bg-surface-subtle p-4">
              <p className="font-semibold">
                {copy('Dense by design', 'common')}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">
                {copy(
                  'Type, spacing, borders, and focus all resolve through shared tokens.',
                  'common',
                )}
              </p>
            </div>
          </section>
        </div>

        <section className="mt-6" aria-labelledby="inventory-title">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">{copy('Component inventory', 'common')}</p>
              <h2 className="mt-2 text-lg font-semibold" id="inventory-title">
                {copy('Initial reusable set', 'common')}
              </h2>
            </div>
            <Status tone="success">
              {copy('5 primitives ready', 'common')}
            </Status>
          </div>
          <Table
            caption={copy('Initial reusable interface primitives', 'common')}
          >
            <thead>
              <tr>
                <th scope="col">{copy('Primitive', 'common')}</th>
                <th scope="col">{copy('Intended use', 'common')}</th>
                <th scope="col">{copy('State', 'common')}</th>
              </tr>
            </thead>
            <tbody>
              {inventory.map(([name, use, state]) => (
                <tr key={name}>
                  <th className="whitespace-nowrap font-semibold" scope="row">
                    {name}
                  </th>
                  <td className="min-w-64 text-muted">{use}</td>
                  <td>
                    <Status tone="success">{state}</Status>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>

        <p className="mt-6 text-xs leading-5 text-muted">
          {copy(
            'This route is a development review surface, not an application module or component catalog product.',
            'common',
          )}
        </p>
      </main>

      <Dialog
        open={resetOpen}
        title={copy('Reset the local example?', 'common')}
        description={copy(
          'This clears only the label and messages on this review page. It does not modify application or client data.',
          'common',
        )}
        onClose={() => setResetOpen(false)}
      >
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={() => setResetOpen(false)}>
            {copy('Keep example', 'common')}
          </Button>
          <Button variant="danger" icon={faRotateLeft} onClick={reset}>
            {copy('Reset local example', 'common')}
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
