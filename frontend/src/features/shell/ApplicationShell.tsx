import { useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBars, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useAuth } from '../auth/auth-context'
import { visibleDestinations } from './navigation'
import { AccountMenu } from './AccountMenu'

export function ApplicationShell() {
  const auth = useAuth()
  const location = useLocation()
  const navigation = visibleDestinations(auth.session?.user.permissions ?? [])
  const [mobileOpen, setMobileOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const firstLinkRef = useRef<HTMLAnchorElement>(null)
  const current = navigation.find((item) => item.path === location.pathname)

  function closeNavigation() {
    setMobileOpen(false)
    toggleRef.current?.focus()
  }

  return <div className="min-h-dvh">
    <a href="#workspace-content" className="sr-only fixed left-4 top-4 z-50 rounded-sm bg-ink px-4 py-2 text-surface focus:not-sr-only">Skip to content</a>
    <header className="flex min-h-16 items-center justify-between gap-3 border-b border-line bg-surface px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <button ref={toggleRef} className="ui-button min-h-10 border-line bg-surface px-3 lg:hidden" aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileOpen} aria-controls="application-navigation" onClick={() => {
          setMobileOpen(!mobileOpen)
          if (!mobileOpen) window.requestAnimationFrame(() => firstLinkRef.current?.focus())
        }}><FontAwesomeIcon icon={mobileOpen ? faXmark : faBars} aria-hidden="true" /></button>
        <Link to="/app" className="whitespace-nowrap font-semibold tracking-tight">ROISEY ELSE</Link>
      </div>
      <AccountMenu />
    </header>
    <div className="mx-auto grid max-w-[100rem] lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className={`${mobileOpen ? 'block' : 'hidden'} border-b border-line bg-surface lg:block lg:border-b-0 lg:border-r`} id="application-navigation" onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeNavigation() }
      }}>
        <nav className="grid gap-1 p-4" aria-label="Application">
          <p className="eyebrow px-3 pb-3 pt-2">Workspace</p>
          {navigation.map((item, index) => <NavLink key={item.path} to={item.path} end ref={index === 0 ? firstLinkRef : undefined} onClick={() => {
            setMobileOpen(false)
            window.requestAnimationFrame(() => document.getElementById('workspace-content')?.focus())
          }} className={({ isActive }) => `flex min-h-10 items-center gap-3 rounded-sm border px-3 py-2 font-semibold ${isActive ? 'border-line bg-surface-subtle text-ink' : 'border-transparent text-muted hover:bg-surface-subtle hover:text-ink'}`}>
            <FontAwesomeIcon icon={item.icon} className="w-4" aria-hidden="true" />{item.label}
          </NavLink>)}
          <Link to="/status" className="mt-5 min-h-10 border-t border-line px-3 pt-4 text-sm text-muted underline underline-offset-4">Service status</Link>
        </nav>
      </aside>
      <main id="workspace-content" tabIndex={-1} className="min-w-0 px-5 py-6 sm:px-8 sm:py-8">
        <nav aria-label="Breadcrumb" className="mb-8 text-xs text-muted">
          <ol className="flex flex-wrap items-center gap-2"><li><Link className="underline underline-offset-4" to="/app">Roisey Else</Link></li><li aria-hidden="true">/</li><li aria-current="page">{current?.label ?? 'Page not found'}</li></ol>
        </nav>
        <Outlet />
      </main>
    </div>
  </div>
}
