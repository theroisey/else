import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'

/** Preserve keyboard orientation without intercepting or delaying navigation. */
export function NavigationFocus({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const previousPath = useRef(pathname)
  useLayoutEffect(() => {
    if (previousPath.current === pathname) return
    previousPath.current = pathname
    const main =
      document.getElementById('workspace-content') ??
      document.querySelector<HTMLElement>('.login-main')
    main?.focus({ preventScroll: true })
  }, [pathname])
  return children
}
