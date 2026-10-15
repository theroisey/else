import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import type { ReactNode } from 'react'
import { UNSAFE_NavigationContext, useLocation } from 'react-router'
import type { Navigator, To } from 'react-router'
import { useAuth } from '../auth/auth-context'

/** Animate the live workspace, never a captured or retained private route tree. */
export function NavigationTransitions({ children }: { children: ReactNode }) {
  const context = useContext(UNSAFE_NavigationContext)
  const { pathname } = useLocation()
  const auth = useAuth()
  const security = JSON.stringify([
    auth.status,
    auth.session?.user.id,
    auth.session?.user.permissions,
  ])
  const pending = useRef<{
    animation: Animation
    element: HTMLElement
    timer: number
    committed: boolean
  } | null>(null)
  const entrance = useRef<Animation | null>(null)
  const previousPath = useRef(pathname)
  const cancel = useCallback(() => {
    const previous = pending.current
    pending.current = null
    if (previous) {
      window.clearTimeout(previous.timer)
      previous.element.inert = false
      previous.animation.cancel()
    }
    entrance.current?.cancel()
    entrance.current = null
  }, [])
  const move = useCallback(
    (action: () => void, destination?: To) => {
      cancel()
      const next =
        typeof destination === 'string'
          ? destination.split(/[?#]/)[0]
          : destination?.pathname
      const element = document.getElementById('workspace-content')
      if (
        auth.status !== 'signed-in' ||
        !pathname.startsWith('/app') ||
        (destination !== undefined &&
          (!next?.startsWith('/app') || next === pathname)) ||
        !element?.animate ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ) {
        action()
        return
      }
      const animation = element.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 90,
        easing: 'ease-in',
        fill: 'forwards',
      })
      const transition = { animation, element, timer: 0, committed: false }
      pending.current = transition
      element.inert = true
      const commit = () => {
        if (pending.current !== transition || transition.committed) return
        transition.committed = true
        window.clearTimeout(transition.timer)
        // go(-1) at the beginning of history may produce no location update.
        transition.timer = window.setTimeout(cancel, 400)
        try {
          action()
        } catch (error) {
          cancel()
          throw error
        }
      }
      // A suspended/background animation must not indefinitely prevent navigation.
      transition.timer = window.setTimeout(commit, 140)
      void animation.finished.then(commit, () => {})
    },
    [auth.status, cancel, pathname],
  )
  const navigator = useMemo<Navigator>(
    () => ({
      ...context.navigator,
      push: (...args) => move(() => context.navigator.push(...args), args[0]),
      replace: (...args) =>
        move(() => context.navigator.replace(...args), args[0]),
      go: (...args) => move(() => context.navigator.go(...args)),
    }),
    [context.navigator, move],
  )

  useLayoutEffect(() => {
    // Current guards remain live during the exit. Auth/grant changes cancel it
    // immediately; they never wait for navigation or preserve an old DOM copy.
    cancel()
    const element =
      document.getElementById('workspace-content') ??
      document.querySelector<HTMLElement>('.login-main')
    if (previousPath.current !== pathname) {
      element?.focus({ preventScroll: true })
      previousPath.current = pathname
    }
    if (
      element?.animate &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      const animation = element.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 160,
        easing: 'ease-out',
      })
      entrance.current = animation
      void animation.finished.catch(() => {})
    }
    return cancel
  }, [pathname, security, cancel])

  return (
    <UNSAFE_NavigationContext.Provider value={{ ...context, navigator }}>
      {children}
    </UNSAFE_NavigationContext.Provider>
  )
}
