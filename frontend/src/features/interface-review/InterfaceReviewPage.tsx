import { useState } from 'react'
import type { FormEvent } from 'react'
import { faRotateLeft, faSave } from '@fortawesome/free-solid-svg-icons'
import { Link } from 'react-router'
import { Button, Dialog, Status, Table, TextField, buttonStyles } from '../../components/ui'

const inventory = [
  ['Button', 'Actions and form submission', 'Ready'],
  ['Text field', 'Labels, guidance, validation', 'Ready'],
  ['Status', 'Text-backed semantic state', 'Ready'],
  ['Table', 'Dense, responsive records', 'Ready'],
  ['Dialog', 'Confirmed destructive actions', 'Ready'],
] as const

export function InterfaceReviewPage() {
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [resetOpen, setResetOpen] = useState(false)

  function validate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!label.trim()) {
      setError('Enter a review label before saving this local example.')
      setMessage('')
      return
    }
    setError('')
    setMessage(`“${label.trim()}” is valid for this local component review.`)
  }

  function reset() {
    setLabel('')
    setError('')
    setMessage('The local review example was reset. No application data changed.')
    setResetOpen(false)
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <span className="font-semibold tracking-tight">ROISEY ELSE</span>
          <Link className={buttonStyles({ variant: 'ghost', size: 'compact' })} to="/status">
            <span aria-hidden="true">←</span>
            Service status
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="grid gap-4 border-b border-line pb-8 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <p className="eyebrow">Interface foundation</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Compact, clear, operational.</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
              A bounded review surface for shared controls. Examples use local UI state only and contain no client, credential, or business data.
            </p>
          </div>
          <Status>Internal review</Status>
        </div>

        <div className="review-grid mt-6">
          <section className="review-card" aria-labelledby="form-review-title">
            <p className="eyebrow">Form controls</p>
            <h2 className="mt-2 text-lg font-semibold" id="form-review-title">Label validation</h2>
            <p className="mt-2 text-sm leading-6 text-muted">Submit an in-memory label to review help, error, success, and button states.</p>
            <form className="mt-5 grid gap-4" onSubmit={validate} noValidate>
              <TextField
                label="Review label"
                description="Local component example; nothing is sent to the backend."
                error={error}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Example label"
                autoComplete="off"
              />
              <TextField label="Disabled field" description="This control demonstrates an unavailable input." value="Unavailable example" disabled />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" icon={faSave}>Validate label</Button>
                <Button variant="danger" icon={faRotateLeft} onClick={() => setResetOpen(true)}>Reset example</Button>
                <Button disabled>Disabled action</Button>
              </div>
              {message ? <p className="text-sm text-success-ink" role="status">{message}</p> : null}
            </form>
          </section>

          <section className="review-card" aria-labelledby="status-review-title">
            <p className="eyebrow">Semantic state</p>
            <h2 className="mt-2 text-lg font-semibold" id="status-review-title">Status treatments</h2>
            <p className="mt-2 text-sm leading-6 text-muted">Meaning is always written. Color only reinforces the label.</p>
            <div className="mt-5 flex flex-wrap gap-2" aria-label="Status examples">
              <Status>Neutral</Status>
              <Status tone="success">Ready</Status>
              <Status tone="warning">Attention</Status>
              <Status tone="danger">Blocked</Status>
            </div>
            <div className="mt-6 rounded-sm border border-line bg-surface-subtle p-4">
              <p className="font-semibold">Dense by design</p>
              <p className="mt-1 text-sm leading-6 text-muted">Type, spacing, borders, and focus all resolve through shared tokens.</p>
            </div>
          </section>
        </div>

        <section className="mt-6" aria-labelledby="inventory-title">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Component inventory</p>
              <h2 className="mt-2 text-lg font-semibold" id="inventory-title">Initial reusable set</h2>
            </div>
            <Status tone="success">5 primitives ready</Status>
          </div>
          <Table caption="Initial reusable interface primitives">
            <thead>
              <tr><th scope="col">Primitive</th><th scope="col">Intended use</th><th scope="col">State</th></tr>
            </thead>
            <tbody>
              {inventory.map(([name, use, state]) => (
                <tr key={name}>
                  <th className="whitespace-nowrap font-semibold" scope="row">{name}</th>
                  <td className="min-w-64 text-muted">{use}</td>
                  <td><Status tone="success">{state}</Status></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>

        <p className="mt-6 text-xs leading-5 text-muted">This route is a development review surface, not an application module or component catalog product.</p>
      </main>

      <Dialog
        open={resetOpen}
        title="Reset the local example?"
        description="This clears only the label and messages on this review page. It does not modify application or client data."
        onClose={() => setResetOpen(false)}
      >
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={() => setResetOpen(false)}>Keep example</Button>
          <Button variant="danger" icon={faRotateLeft} onClick={reset}>Reset local example</Button>
        </div>
      </Dialog>
    </div>
  )
}
