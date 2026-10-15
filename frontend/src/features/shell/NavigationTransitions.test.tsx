import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router'
import { AuthContext, useAuth } from '../auth/auth-context'
import type { AuthState } from '../auth/auth-context'
import { NavigationTransitions } from './NavigationTransitions'

const signedIn: AuthState = {
  status: 'signed-in',
  expired: false,
  session: {
    user: {
      id: 'actor',
      display_name: 'Synthetic actor',
      email: 'synthetic@example.com',
      permissions: [{ permission: 'clients.view', scope: 'global' }],
    },
    session: { expires_at: '2099-01-01T00:00:00Z' },
  },
  login: async () => {},
  logout: async () => {},
  refresh: async () => {},
}
let reduced = false
let finishes: Array<() => void> = []
const originalAnimate = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'animate',
)
const animate = vi.fn(() => {
  let finish = () => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  finishes.push(finish)
  return { finished, cancel: vi.fn() } as unknown as Animation
})
beforeEach(() => {
  vi.useFakeTimers()
  reduced = false
  finishes = []
  animate.mockClear()
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    value: animate,
    configurable: true,
  })
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
})
afterEach(() => {
  if (originalAnimate)
    Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  vi.useRealTimers()
})
function setup() {
  let revoke: (grantsOnly?: boolean) => void = () => {}
  function Workspace() {
    const auth = useAuth()
    const location = useLocation()
    const navigate = useNavigate()
    return (
      <>
        <Link to="/app/next">Next</Link>
        <Link to="/app/last">Last</Link>
        <button onClick={() => navigate(-1)}>Back</button>
        <output>{location.pathname}</output>
        <main id="workspace-content">
          {auth.status === 'signed-in' &&
          auth.session?.user.permissions.length ? (
            <Routes>
              <Route
                path="/app"
                element={
                  <input aria-label="Draft" defaultValue="Private draft" />
                }
              />
              <Route path="*" element={<p>Next workspace</p>} />
            </Routes>
          ) : (
            <p>Signed out</p>
          )}
        </main>
      </>
    )
  }
  // The guard stays reactive independently of the pending navigation.
  function Root() {
    const [auth, setAuth] = useState(signedIn)
    revoke = (grantsOnly = false) =>
      setAuth(
        grantsOnly
          ? {
              ...signedIn,
              session: {
                ...signedIn.session!,
                user: { ...signedIn.session!.user, permissions: [] },
              },
            }
          : { ...signedIn, status: 'signed-out', session: null },
      )
    return (
      <AuthContext.Provider value={auth}>
        <NavigationTransitions>
          <Workspace />
        </NavigationTransitions>
      </AuthContext.Provider>
    )
  }
  const view = render(
    <MemoryRouter initialEntries={['/app']}>
      <Root />
    </MemoryRouter>,
  )
  return { ...view, revoke: (grantsOnly = false) => revoke(grantsOnly) }
}
it('fades out before route commit, then fades in without keeping an old route copy', async () => {
  setup()
  fireEvent.click(screen.getByText('Next'))
  expect(screen.getByLabelText('Draft')).toHaveValue('Private draft')
  expect(document.getElementById('workspace-content')!.inert).toBe(true)
  expect(animate.mock.calls).toHaveLength(2) // initial entrance + exit
  await act(async () => finishes.at(-1)!())
  expect(screen.getByText('/app/next')).toBeVisible()
  expect(screen.queryByLabelText('Draft')).not.toBeInTheDocument()
  expect(document.getElementById('workspace-content')!.inert).toBe(false)
  expect(animate).toHaveBeenCalledTimes(3)
})
it('cancels a pending exit immediately when authentication or grants are lost', async () => {
  for (const grantsOnly of [false, true]) {
    const { revoke, unmount } = setup()
    fireEvent.click(screen.getByText('Next'))
    act(() => revoke(grantsOnly))
    expect(screen.queryByLabelText('Draft')).not.toBeInTheDocument()
    expect(screen.getByText('Signed out')).toBeVisible()
    await act(async () => {
      finishes.forEach((finish) => finish())
      vi.runAllTimers()
    })
    expect(screen.getByText('/app')).toBeVisible()
    expect(document.getElementById('workspace-content')!.inert).toBe(false)
    unmount()
  }
})
it('uses the latest destination and recovers when back has no earlier history entry', async () => {
  setup()
  fireEvent.click(screen.getByText('Back'))
  await act(async () => {
    vi.advanceTimersByTime(550)
  })
  expect(document.getElementById('workspace-content')!.inert).toBe(false)
  fireEvent.click(screen.getByText('Next'))
  fireEvent.click(screen.getByText('Last'))
  await act(async () => {
    finishes.forEach((finish) => finish())
  })
  expect(screen.getByText('/app/last')).toBeVisible()
  expect(screen.queryByText('/app/next')).not.toBeInTheDocument()
})
it('navigates immediately without any animation when reduced motion is requested', () => {
  reduced = true
  setup()
  fireEvent.click(screen.getByText('Next'))
  expect(screen.getByText('/app/next')).toBeVisible()
  expect(animate).not.toHaveBeenCalled()
})
