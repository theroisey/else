import { useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBars, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useAuth } from '../auth/auth-context'
import { visibleDestinations } from './navigation'
import { AccountMenu } from './AccountMenu'
import { Brand } from '../../components/brand/Brand'
import { CommandSearch } from './CommandSearch'
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
  const reportsContext = /\/(analytics|commerce|marketing)(?:\/|$)/.exec(location.pathname)?.[1]
  const clientContext = (reportsContext ? { analytics: 'Web analytics', commerce: 'Commerce', marketing: 'Marketing' }[reportsContext] : '') || profileContext || overviewContext || integrationContext || pricingContext || billingContext || auditContext || activityContext || reminderContext || taskContext || planningContext || (current?.path === '/app/clients' && location.pathname !== current.path
    ? location.pathname === '/app/clients/new' ? 'Create client' : location.pathname.endsWith('/edit') ? 'Edit client' : 'Client workspace' : '')

  function closeNavigation() {
    setMobileOpen(false)
    toggleRef.current?.focus()
  }

  return <div className="min-h-dvh">
    <a href="#workspace-content" className="sr-only fixed left-4 top-4 z-50 rounded-sm bg-ink px-4 py-2 text-surface focus:not-sr-only">Skip to content</a>
    <header className="shell-header">
      <div className="shell-brand">
        <button ref={toggleRef} className="ui-button min-h-9 border-line bg-surface px-2 lg:hidden" aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileOpen} aria-controls="application-navigation" onClick={() => {
          setMobileOpen(!mobileOpen)
          if (!mobileOpen) window.requestAnimationFrame(() => firstLinkRef.current?.focus())
        }}><FontAwesomeIcon icon={mobileOpen ? faXmark : faBars} aria-hidden="true" /></button>
        <Link to="/app" aria-label="ROISEY ELSE"><Brand /></Link>
      </div>
      <div className="shell-toolbar">
        <nav aria-label="Breadcrumb" className="shell-breadcrumb"><ol>
          <li><Link to="/app">Workspace</Link></li><li aria-hidden="true">/</li>
          {clientContext && navigation.some(item => item.path === '/app/clients') ? <><li><Link to="/app/clients">Clients</Link></li><li aria-hidden="true">/</li></> : null}
          <li aria-current="page">{clientContext || current?.label || 'Page not found'}</li>
        </ol></nav>
        <div className="ml-auto flex min-w-0 items-center gap-3"><CommandSearch /><AccountMenu /></div>
      </div>
    </header>
    <div className="shell-grid">
      <aside className={`${mobileOpen ? 'block' : 'hidden'} shell-sidebar lg:block`} id="application-navigation" onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeNavigation() }
      }}>
        <div className="sidebar-inner"><nav className="sidebar-nav" aria-label="Application">
          <p className="eyebrow px-3 pb-4">Private operations</p>
          {navigation.map((item, index) => <NavLink key={item.path} to={item.path} end={item.path !== '/app/clients'} ref={index === 0 ? firstLinkRef : undefined} onClick={() => {
            setMobileOpen(false)
            window.requestAnimationFrame(() => document.getElementById('workspace-content')?.focus())
          }} className={({ isActive }) => `sidebar-link ${isActive || (item.path === '/app/clients' && clientContext) ? 'is-active' : ''}`}>
            <FontAwesomeIcon icon={item.icon} aria-hidden="true" />{item.label}
          </NavLink>)}
          <Link to="/service-status" className="sidebar-link mt-5 border-t border-line pt-4">Service status</Link>
        </nav><div className="mt-auto border-t border-line px-3 pt-5"><p className="eyebrow mb-4">Workspace edition</p><ReleaseIndicator /><p className="mt-3 text-[0.625rem] leading-5 text-muted">Roisey Else<br />Client operations &amp; intelligence</p></div></div>
      </aside>
      <main id="workspace-content" tabIndex={-1} className="workspace-main"><Outlet /></main>
    </div>
  </div>
}
