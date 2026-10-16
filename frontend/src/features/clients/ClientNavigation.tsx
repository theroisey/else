import { copy, useLocale } from '../../i18n/index'
import { WebsiteNavigation } from '../websites/WebsiteNavigation'
import { NavLink, useLocation, useParams } from 'react-router'
import { useId, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { useAuth } from '../auth/auth-context'
import { hasPermission } from '../auth/permissions'

export function ClientNavigation({ clientID }: { clientID: string }) {
  useLocale()
  const { websiteID } = useParams()
  const { pathname } = useLocation()
  const moreID = useId()
  const moreButton = useRef<HTMLButtonElement>(null)
  const [disclosure, setDisclosure] = useState<{
    path: string
    open: boolean
  } | null>(null)
  const grants = useAuth().session?.user.permissions ?? []
  const base = `/app/clients/${clientID}`
  const allowed = (permission: string) =>
    hasPermission(grants, {
      permission,
      scope: permission === 'audit.view' ? 'global' : 'client',
      clientID,
    })
  const work = [
    [
      copy('Technical requests', 'operations'),
      '/requests',
      allowed('tickets.read_own') ||
        allowed('tickets.read_team') ||
        allowed('tickets.read_all'),
    ],
    [
      copy('Tasks', 'clients'),
      '/tasks',
      allowed('tasks.view') ||
        allowed('tasks.read_own') ||
        allowed('tasks.read_team') ||
        allowed('tasks.read_development'),
    ],
    [copy('Reminders', 'clients'), '/reminders', allowed('reminders.view')],
    [copy('Planning', 'clients'), '/plans', allowed('planning.view')],
    [
      copy('Recurring tasks', 'operations'),
      '/recurring-tasks',
      allowed('recurring.view'),
    ],
  ] as const
  const finance = [
    [
      copy('Service finance', 'operations'),
      '/finance',
      allowed('agreements.view') && allowed('billing.view'),
    ],
    [copy('Finance', 'clients'), '/billing', allowed('billing.view')],
    [
      copy('Pricing', 'clients'),
      '/pricing',
      allowed('pricing.view') && allowed('billing.view'),
    ],
  ] as const
  const advanced = [
    [
      copy('Pricing', 'clients'),
      '/pricing',
      allowed('pricing.view') && !allowed('billing.view'),
    ],
    [copy('Profile', 'clients'), '/profile', allowed('clients.view')],
    [copy('Marketing', 'clients'), '/marketing', allowed('analytics.view')],
    [copy('Commerce', 'clients'), '/commerce', allowed('analytics.view')],
    [copy('Web analytics', 'clients'), '/analytics', allowed('analytics.view')],
    [copy('Activity', 'clients'), '/activity', allowed('activity.view')],
    [
      copy('Audit history', 'clients'),
      '/audit',
      allowed('audit.view') && allowed('clients.view'),
    ],
    [
      copy('Integrations', 'clients'),
      '/integrations',
      allowed('integrations.view'),
    ],
  ] as const
  const contains = (path: string) =>
    pathname === base + path || pathname.startsWith(base + path + '/')
  const workActive = work.some(([, path, visible]) => visible && contains(path))
  const financeActive = finance.some(
    ([, path, visible]) => visible && contains(path),
  )
  const moreActive = advanced.some(
    ([, path, visible]) => visible && contains(path),
  )
  const moreOpen = disclosure?.path === pathname ? disclosure.open : moreActive
  const workFirst = work.find(([, , visible]) => visible)
  const financeFirst = finance.find(([, , visible]) => visible)
  const tab = (label: string, path: string, active: boolean) => (
    <NavLink
      key={path}
      to={base + path}
      onClick={() => setDisclosure({ path: pathname, open: false })}
      end={path === ''}
      className={() => (active ? 'client-tab is-active' : 'client-tab')}
    >
      {label}
    </NavLink>
  )
  return (
    <>
      <nav
        aria-label={copy('Client modules', 'clients')}
        className="mb-7"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && moreOpen) {
            event.preventDefault()
            setDisclosure({ path: pathname, open: false })
            moreButton.current?.focus()
          }
        }}
      >
        <div className="client-navigation">
          {allowed('clients.view')
            ? tab(copy('Summary', 'operations'), '', pathname === base)
            : null}
          {workFirst
            ? tab(copy('Work', 'operations'), workFirst[1], workActive)
            : null}
          {allowed('clients.view')
            ? tab(
                copy('Websites', 'clients'),
                '/websites',
                contains('/websites'),
              )
            : null}
          {financeFirst
            ? tab(copy('Finance', 'clients'), financeFirst[1], financeActive)
            : null}
          {advanced.some(([, , visible]) => visible) ? (
            <button
              ref={moreButton}
              type="button"
              aria-expanded={moreOpen}
              aria-controls={moreID}
              onClick={() => setDisclosure({ path: pathname, open: !moreOpen })}
              className={
                moreActive ? 'client-tab is-active gap-2' : 'client-tab gap-2'
              }
            >
              {copy('More', 'operations')}
              <FontAwesomeIcon
                icon={faChevronDown}
                className="client-more-chevron"
              />
            </button>
          ) : null}
        </div>
        {advanced.some(([, , visible]) => visible) ? (
          <div id={moreID} hidden={!moreOpen} className="client-more-sections">
            {advanced
              .filter(([, , visible]) => visible)
              .map(([label, path]) => (
                <NavLink
                  key={path}
                  to={base + path}
                  className={() =>
                    contains(path)
                      ? 'client-section-link is-active'
                      : 'client-section-link'
                  }
                >
                  {label}
                </NavLink>
              ))}
          </div>
        ) : null}
      </nav>
      {workActive || financeActive ? (
        <nav
          aria-label={copy(
            workActive ? 'Work sections' : 'Financial sections',
            'operations',
          )}
          className="mb-6 flex flex-wrap gap-x-5 gap-y-3 border-b border-line pb-3"
        >
          {(workActive ? work : finance)
            .filter(([, , visible]) => visible)
            .map(([label, path]) => (
              <NavLink
                key={path}
                to={base + path}
                className={() =>
                  contains(path)
                    ? 'text-sm font-semibold underline underline-offset-8'
                    : 'text-sm text-muted hover:text-ink'
                }
              >
                {label}
              </NavLink>
            ))}
        </nav>
      ) : null}
      {websiteID ? <WebsiteNavigation clientID={clientID} /> : null}
    </>
  )
}
