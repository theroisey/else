import { copy, useLocale } from '../../i18n/index'
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
  useLocale()
  const auth = useAuth()
  const location = useLocation()
  const navigation = visibleDestinations(auth.session?.user.permissions ?? [])
  const [mobileOpen, setMobileOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const firstLinkRef = useRef<HTMLAnchorElement>(null)
  const current = navigation.find(
    (item) =>
      item.path === location.pathname ||
      (item.path === '/app/clients' &&
        location.pathname.startsWith('/app/clients/')),
  )
  const taskContext = /^\/app\/clients\/[^/]+\/tasks(?:\/|$)/.test(
    location.pathname,
  )
    ? location.pathname.endsWith('/new')
      ? copy('Create task', 'common')
      : location.pathname.endsWith('/edit')
        ? copy('Edit task', 'common')
        : location.pathname.endsWith('/tasks')
          ? copy('Tasks', 'common')
          : copy('Task details', 'common')
    : ''
  const reminderContext = /^\/app\/clients\/[^/]+\/reminders(?:\/|$)/.test(
    location.pathname,
  )
    ? location.pathname.endsWith('/new')
      ? copy('Create reminder', 'common')
      : location.pathname.endsWith('/edit')
        ? copy('Edit reminder', 'common')
        : location.pathname.endsWith('/reminders')
          ? copy('Reminders', 'common')
          : copy('Reminder details', 'common')
    : ''
  const planningContext = /^\/app\/clients\/[^/]+\/plans(?:\/|$)/.test(
    location.pathname,
  )
    ? location.pathname.includes('/milestones')
      ? location.pathname.endsWith('/new')
        ? copy('Create milestone', 'common')
        : location.pathname.endsWith('/edit')
          ? copy('Edit milestone', 'common')
          : location.pathname.endsWith('/milestones')
            ? copy('Milestones', 'common')
            : copy('Milestone details', 'common')
      : location.pathname.endsWith('/new')
        ? copy('Create plan', 'common')
        : location.pathname.endsWith('/edit')
          ? copy('Edit plan', 'common')
          : location.pathname.endsWith('/plans')
            ? copy('Planning', 'common')
            : copy('Plan details', 'common')
    : ''
  const activityContext = /^\/app\/clients\/[^/]+\/activity$/.test(
    location.pathname,
  )
    ? copy('Activity', 'common')
    : ''
  const integrationContext =
    /^\/app\/clients\/[^/]+\/integrations(?:\/|$)/.test(location.pathname)
      ? location.pathname.endsWith('/integrations')
        ? copy('Integrations', 'common')
        : copy('Integration connection', 'common')
      : ''
  const auditContext = /^\/app\/clients\/[^/]+\/audit$/.test(location.pathname)
    ? copy('Audit history', 'common')
    : ''
  const billingContext = /^\/app\/clients\/[^/]+\/billing(?:\/|$)/.test(
    location.pathname,
  )
    ? location.pathname.endsWith('/new')
      ? copy('Create collection', 'common')
      : location.pathname.endsWith('/edit')
        ? copy('Edit collection', 'common')
        : location.pathname.endsWith('/billing')
          ? copy('Finance', 'common')
          : copy('Collection details', 'common')
    : ''
  const pricingContext = /^\/app\/clients\/[^/]+\/pricing(?:\/|$)/.test(
    location.pathname,
  )
    ? location.pathname.endsWith('/new')
      ? copy('Create pricing agreement', 'common')
      : location.pathname.endsWith('/new-version')
        ? copy('Create new pricing version', 'common')
        : location.pathname.endsWith('/pricing')
          ? copy('Pricing agreements', 'common')
          : copy('Pricing agreement', 'common')
    : ''
  const profileContext = /^\/app\/clients\/[^/]+\/profile$/.test(
    location.pathname,
  )
    ? copy('Client profile', 'common')
    : ''
  const overviewContext = /^\/app\/clients\/[0-9a-f-]{36}$/.test(
    location.pathname,
  )
    ? copy('Overview', 'common')
    : ''
  const reportsContext = /\/(analytics|commerce|marketing)(?:\/|$)/.exec(
    location.pathname,
  )?.[1]
  const clientContext =
    (reportsContext
      ? {
          analytics: copy('Web analytics', 'common'),
          commerce: copy('Commerce', 'common'),
          marketing: copy('Marketing', 'common'),
        }[reportsContext]
      : '') ||
    profileContext ||
    overviewContext ||
    integrationContext ||
    pricingContext ||
    billingContext ||
    auditContext ||
    activityContext ||
    reminderContext ||
    taskContext ||
    planningContext ||
    (current?.path === '/app/clients' && location.pathname !== current.path
      ? location.pathname === '/app/clients/new'
        ? copy('Create client', 'common')
        : location.pathname.endsWith('/edit')
          ? copy('Edit client', 'common')
          : copy('Client workspace', 'common')
      : '')

  function closeNavigation() {
    setMobileOpen(false)
    toggleRef.current?.focus()
  }

  return (
    <div className="min-h-dvh">
      <a
        href="#workspace-content"
        className="sr-only fixed left-4 top-4 z-50 rounded-sm bg-ink px-4 py-2 text-surface focus:not-sr-only"
      >
        {copy('Skip to content', 'common')}
      </a>
      <header className="shell-header">
        <div className="shell-brand">
          <button
            ref={toggleRef}
            className="ui-button min-h-9 border-line bg-surface px-2 lg:hidden"
            aria-label={
              mobileOpen
                ? copy('Close navigation', 'common')
                : copy('Open navigation', 'common')
            }
            aria-expanded={mobileOpen}
            aria-controls="application-navigation"
            onClick={() => {
              setMobileOpen(!mobileOpen)
              if (!mobileOpen)
                window.requestAnimationFrame(() =>
                  firstLinkRef.current?.focus(),
                )
            }}
          >
            <FontAwesomeIcon
              icon={mobileOpen ? faXmark : faBars}
              aria-hidden="true"
            />
          </button>
          <Link to="/app" aria-label={copy('ROISEY ELSE', 'common')}>
            <Brand />
          </Link>
        </div>
        <div className="shell-toolbar">
          <nav
            aria-label={copy('Breadcrumb', 'common')}
            className="shell-breadcrumb"
          >
            <ol>
              <li>
                <Link to="/app">{copy('Workspace', 'common')}</Link>
              </li>
              <li aria-hidden="true">/</li>
              {clientContext &&
              navigation.some((item) => item.path === '/app/clients') ? (
                <>
                  <li>
                    <Link to="/app/clients">{copy('Clients', 'common')}</Link>
                  </li>
                  <li aria-hidden="true">/</li>
                </>
              ) : null}
              <li aria-current="page">
                {clientContext ||
                  copy(current?.label, 'common') ||
                  copy('Page not found', 'common')}
              </li>
            </ol>
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            <CommandSearch />
            <AccountMenu />
          </div>
        </div>
      </header>
      <div className="shell-grid">
        <aside
          className={`${mobileOpen ? 'block' : 'hidden'} shell-sidebar lg:block`}
          id="application-navigation"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              closeNavigation()
            }
          }}
        >
          <div className="sidebar-inner">
            <nav
              className="sidebar-nav"
              aria-label={copy('Application', 'common')}
            >
              <p className="eyebrow px-3 pb-4">
                {copy('Private operations', 'common')}
              </p>
              {navigation.map((item, index) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path !== '/app/clients'}
                  ref={index === 0 ? firstLinkRef : undefined}
                  onClick={() => {
                    setMobileOpen(false)
                    window.requestAnimationFrame(() =>
                      document.getElementById('workspace-content')?.focus(),
                    )
                  }}
                  className={({ isActive }) =>
                    `sidebar-link ${isActive || (item.path === '/app/clients' && clientContext) ? 'is-active' : ''}`
                  }
                >
                  <FontAwesomeIcon icon={item.icon} aria-hidden="true" />
                  {copy(item.label, 'common')}
                </NavLink>
              ))}
              <Link
                to="/service-status"
                className="sidebar-link mt-5 border-t border-line pt-4"
              >
                {copy('Service status', 'common')}
              </Link>
            </nav>
            <div className="mt-auto border-t border-line px-3 pt-5">
              <p className="eyebrow mb-4">
                {copy('Workspace edition', 'common')}
              </p>
              <ReleaseIndicator />
              <p className="mt-3 text-[0.625rem] leading-5 text-muted">
                Roisey Else
                <br />
                {copy('Client operations & intelligence', 'common')}
              </p>
            </div>
          </div>
        </aside>
        <main id="workspace-content" tabIndex={-1} className="workspace-main">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
