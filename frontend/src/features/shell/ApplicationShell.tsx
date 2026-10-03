import { useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBars, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useAuth } from '../auth/auth-context'
import { visibleDestinations } from './navigation'
import { AccountMenu } from './AccountMenu'
import { ReleaseIndicator } from '../releases/ReleaseIndicator'

export function ApplicationShell() {
  const auth = useAuth()
  const location = useLocation()
  const navigation = visibleDestinations(auth.session?.user.permissions ?? [])
  const [mobileOpen, setMobileOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const firstLinkRef = useRef<HTMLAnchorElement>(null)
  const current = navigation.find((item) => item.path === location.pathname || (item.path === '/app/clients' && location.pathname.startsWith('/app/clients/')))
  const taskContext = /^\/app\/clients\/[^/]+\/tasks(?:\/|$)/.test(location.pathname)
    ? location.pathname.endsWith('/new') ? 'Create task' : location.pathname.endsWith('/edit') ? 'Edit task' : location.pathname.endsWith('/tasks') ? 'Tasks' : 'Task details' : ''
  const reminderContext = /^\/app\/clients\/[^/]+\/reminders(?:\/|$)/.test(location.pathname)
    ? location.pathname.endsWith('/new') ? 'Create reminder' : location.pathname.endsWith('/edit') ? 'Edit reminder' : location.pathname.endsWith('/reminders') ? 'Reminders' : 'Reminder details' : ''
  const planningContext = /^\/app\/clients\/[^/]+\/plans(?:\/|$)/.test(location.pathname)
    ? location.pathname.includes('/milestones') ? location.pathname.endsWith('/new') ? 'Create milestone' : location.pathname.endsWith('/edit') ? 'Edit milestone' : location.pathname.endsWith('/milestones') ? 'Milestones' : 'Milestone details'
      : location.pathname.endsWith('/new') ? 'Create plan' : location.pathname.endsWith('/edit') ? 'Edit plan' : location.pathname.endsWith('/plans') ? 'Planning' : 'Plan details' : ''
  const activityContext = /^\/app\/clients\/[^/]+\/activity$/.test(location.pathname) ? 'Activity' : ''
  const integrationContext = /^\/app\/clients\/[^/]+\/integrations(?:\/|$)/.test(location.pathname)
    ? location.pathname.endsWith('/integrations') ? 'Integrations' : 'Integration connection' : ''
  const auditContext = /^\/app\/clients\/[^/]+\/audit$/.test(location.pathname) ? 'Audit history' : ''
  const billingContext = /^\/app\/clients\/[^/]+\/billing(?:\/|$)/.test(location.pathname)
    ? location.pathname.endsWith('/new') ? 'Create collection' : location.pathname.endsWith('/edit') ? 'Edit collection' : location.pathname.endsWith('/billing') ? 'Finance' : 'Collection details' : ''
  const pricingContext = /^\/app\/clients\/[^/]+\/pricing(?:\/|$)/.test(location.pathname)
    ? location.pathname.endsWith('/new') ? 'Create pricing agreement' : location.pathname.endsWith('/new-version') ? 'Create new pricing version' : location.pathname.endsWith('/pricing') ? 'Pricing agreements' : 'Pricing agreement' : ''
  const profileContext = /^\/app\/clients\/[^/]+\/profile$/.test(location.pathname) ? 'Client profile' : ''
  const overviewContext = /^\/app\/clients\/[0-9a-f-]{36}$/.test(location.pathname) ? 'Overview' : ''
  const clientContext = profileContext || overviewContext || integrationContext || pricingContext || billingContext || auditContext || activityContext || reminderContext || taskContext || planningContext || (current?.path === '/app/clients' && location.pathname !== current.path
    ? location.pathname === '/app/clients/new' ? 'Create client' : location.pathname.endsWith('/edit') ? 'Edit client' : 'Client workspace' : '')

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
      <div className="flex min-w-0 items-center gap-3"><ReleaseIndicator /><AccountMenu /></div>
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
          }} className={({ isActive }) => `flex min-h-10 items-center gap-3 rounded-sm border px-3 py-2 font-semibold ${isActive || (item.path === '/app/clients' && clientContext) ? 'border-line bg-surface-subtle text-ink' : 'border-transparent text-muted hover:bg-surface-subtle hover:text-ink'}`}>
            <FontAwesomeIcon icon={item.icon} className="w-4" aria-hidden="true" />{item.label}
          </NavLink>)}
          <Link to="/status" className="mt-5 min-h-10 border-t border-line px-3 pt-4 text-sm text-muted underline underline-offset-4">Service status</Link>
        </nav>
      </aside>
      <main id="workspace-content" tabIndex={-1} className="min-w-0 px-5 py-6 sm:px-8 sm:py-8">
        <nav aria-label="Breadcrumb" className="mb-8 text-xs text-muted">
          <ol className="flex flex-wrap items-center gap-2"><li><Link className="underline underline-offset-4" to="/app">Roisey Else</Link></li><li aria-hidden="true">/</li>{clientContext && navigation.some(item => item.path === '/app/clients') ? <><li><Link className="underline underline-offset-4" to="/app/clients">Clients</Link></li><li aria-hidden="true">/</li></> : null}<li aria-current="page">{clientContext || current?.label || 'Page not found'}</li></ol>
        </nav>
        <Outlet />
      </main>
    </div>
  </div>
}
