import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Suspense, useState } from 'react'
import { expect, it } from 'vitest'
import { lazyPage, loadModule } from './lazy-page'

function Editor({ label }: { label: string }) {
  const [draft, setDraft] = useState('')
  return (
    <label>
      {label}
      <input value={draft} onChange={(event) => setDraft(event.target.value)} />
    </label>
  )
}
it('renders prefetched pages immediately and preserves drafts across parent updates', async () => {
  const loader = async () => ({ default: Editor })
  const Page = lazyPage(loader)
  await loadModule(loader)
  const view = render(
    <Suspense fallback={<p>Loading</p>}>
      <Page label="Draft" />
    </Suspense>,
  )
  expect(screen.queryByText('Loading')).not.toBeInTheDocument()
  await userEvent.setup().type(screen.getByRole('textbox'), 'Keep this draft')
  view.rerender(
    <Suspense fallback={<p>Loading</p>}>
      <Page label="Updated label" />
    </Suspense>,
  )
  expect(screen.getByRole('textbox', { name: 'Updated label' })).toHaveValue(
    'Keep this draft',
  )
})
it('keeps a cold page stable after it resolves and rejects then retries a failed intent load', async () => {
  let finish!: (module: { default: typeof Editor }) => void
  const loader = () =>
    new Promise<{ default: typeof Editor }>((resolve) => {
      finish = resolve
    })
  const Page = lazyPage(loader)
  const view = render(
    <Suspense fallback={<p>Loading</p>}>
      <Page label="Draft" />
    </Suspense>,
  )
  expect(screen.getByText('Loading')).toBeVisible()
  await act(async () => {
    await Promise.resolve()
    finish({ default: Editor })
  })
  await userEvent
    .setup()
    .type(await screen.findByRole('textbox'), 'Keep after loading')
  view.rerender(
    <Suspense fallback={<p>Loading</p>}>
      <Page label="Updated label" />
    </Suspense>,
  )
  expect(screen.getByRole('textbox')).toHaveValue('Keep after loading')
  let fail = true
  const retryable = async () => {
    if (fail) throw new Error('Synthetic code load failure')
    return { default: Editor }
  }
  await expect(loadModule(retryable)).rejects.toThrow(
    'Synthetic code load failure',
  )
  fail = false
  await expect(loadModule(retryable)).resolves.toEqual({ default: Editor })
})
