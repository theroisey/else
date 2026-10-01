import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'

function renderReview() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/interface']}><App /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('interface review', () => {
  it('uses real component inventory without service or business requests', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderReview()
    expect(screen.getByRole('heading', { name: 'Compact, clear, operational.' })).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Initial reusable interface primitives' })).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(6)
    expect(screen.getByText(/no client, credential, or business data/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('binds input guidance and errors, then reports local success', async () => {
    renderReview()
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: 'Review label' })
    const description = screen.getByText(/nothing is sent to the backend/i)
    expect(input).toHaveAttribute('aria-describedby', description.id)

    await user.click(screen.getByRole('button', { name: 'Validate label' }))
    const error = screen.getByRole('alert')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', `${description.id} ${error.id}`)

    await user.type(input, 'Keyboard review')
    await user.click(screen.getByRole('button', { name: 'Validate label' }))
    expect(screen.getByRole('status')).toHaveTextContent('Keyboard review')
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('traps dialog focus, closes with Escape, and restores trigger focus', async () => {
    renderReview()
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: 'Reset example' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Reset the local example?' })
    expect(dialog).toHaveAttribute('aria-describedby')
    expect(screen.getByRole('button', { name: 'Keep example' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Reset local example' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Keep example' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Reset local example' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Keep example' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(dialog).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('dismisses through the backdrop and restores scrolling and focus', async () => {
    renderReview()
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: 'Reset example' })
    const originalOverflow = document.body.style.overflow
    await user.click(trigger)
    expect(document.body.style.overflow).toBe('hidden')
    await user.click(screen.getByRole('dialog', { name: 'Reset the local example?' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe(originalOverflow)
    expect(trigger).toHaveFocus()
  })

  it('resets only local state after explicit confirmation', async () => {
    renderReview()
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: 'Review label' })
    await user.type(input, 'Temporary label')
    await user.click(screen.getByRole('button', { name: 'Reset example' }))
    await user.click(screen.getByRole('button', { name: 'Reset local example' }))
    expect(input).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent('No application data changed')
    expect(screen.getByRole('button', { name: 'Disabled action' })).toBeDisabled()
  })
})
