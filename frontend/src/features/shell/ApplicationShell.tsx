import { copy, useLocale } from '../../i18n/index'
import { useLayoutEffect, useSyncExternalStore } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { SectionHelp } from '../../components/ui/Help'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useAuth } from '../auth/auth-context'
import { visibleDestinations } from './navigation'
import { AccountMenu } from './AccountMenu'
import { NotificationControl } from '../operations/Notifications'
import { Brand } from '../../components/brand/Brand'
import { CommandSearch } from './CommandSearch'
import { preloadLink } from '../../app/prefetch'
import { MobileNavigation } from './MobileNavigation'

const mobileQuery = '(max-width: 1023px)'
function mobileLayout() {
  return window.matchMedia?.(mobileQuery).matches ?? false
}
function subscribeLayout(onChange: () => void) {
  const media = window.matchMedia?.(mobileQuery)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}

export function ApplicationShell() {
  useLocale()
  const mobile = useSyncExternalStore(subscribeLayout, mobileLayout)
  // A cold layout chunk can mount after the route's first focus effect.
  useLayoutEffect(() => {
    document.getElementById('workspace-content')?.focus({ preventScroll: true })
  }, [])
  const auth = useAuth()
  const location = useLocation()
  const navigation = visibleDestinations(auth.session?.user.permissions ?? [])
  const advancedPaths = [
    '/app/portfolio',
    '/app/users',
    '/app/roles',
    '/app/audit',
  ]
  const primary = navigation.filter(
    (item) => !advancedPaths.includes(item.path),
  )
  const advanced = navigation.filter((item) =>
    advancedPaths.includes(item.path),
  )
  const current = navigation.find(
    (item) =>
      item.path === location.pathname ||
      (['/app/clients', '/app/team'].includes(item.path) &&
        location.pathname.startsWith(item.path + '/')),
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

  return (
    <div
      className="min-h-dvh"
      onPointerOverCapture={preloadLink}
      onFocusCapture={preloadLink}
    >
      <a
        href="#workspace-content"
        className="sr-only fixed left-4 top-4 z-50 rounded-sm bg-ink px-4 py-2 text-surface focus:not-sr-only"
      >
        {copy('Skip to content', 'common')}
      </a>
      <header className="shell-header">
        <div className="shell-brand">
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
          <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-3">
            <CommandSearch />
            <SectionHelp />
            <NotificationControl />
            <AccountMenu />
          </div>
        </div>
      </header>
      <div className="shell-grid">
        <aside className="shell-sidebar hidden lg:block">
          <div className="sidebar-inner">
            <nav
              className="sidebar-nav"
              aria-label={copy('Application', 'common')}
            >
              <p className="eyebrow px-3 pb-4">
                {copy('Private operations', 'common')}
              </p>
              {primary.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={!['/app/clients', '/app/team'].includes(item.path)}
                  onClick={() => {
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
              <details
                className="mt-5 border-t border-line pt-4"
                open={
                  advancedPaths.includes(location.pathname) ? true : undefined
                }
              >
                <summary className="sidebar-link cursor-pointer">
                  {copy('More', 'operations')}
                </summary>
                {advanced.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={!['/app/clients', '/app/team'].includes(item.path)}
                    onClick={() => {
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
              </details>
            </nav>
            <div className="mt-auto border-t border-line px-3 pt-5">
              <p className="eyebrow mb-4">
                {copy('Workspace edition', 'common')}
              </p>
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
      {mobile ? <MobileNavigation navigation={navigation} /> : null}
    </div>
  )
}
