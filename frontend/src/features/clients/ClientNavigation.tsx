import { copy, useLocale } from '../../i18n/index'
import { WebsiteNavigation } from '../websites/WebsiteNavigation'
import { NavLink, useParams } from 'react-router'
import { useAuth } from '../auth/auth-context'
import { hasPermission } from '../auth/permissions'

export function ClientNavigation({ clientID }: { clientID: string }) {
  useLocale()
  const { websiteID } = useParams()
  const grants = useAuth().session?.user.permissions ?? []
  const base = `/app/clients/${clientID}`
  const links = [
    [copy('Overview', 'clients'), '', 'clients.view'],
    [copy('Profile', 'clients'), '/profile', 'clients.view'],
    [copy('Websites', 'clients'), '/websites', 'clients.view'],
    [copy('Tasks', 'clients'), '/tasks', 'tasks.view'],
    [copy('Planning', 'clients'), '/plans', 'planning.view'],
    [copy('Reminders', 'clients'), '/reminders', 'reminders.view'],
    [copy('Finance', 'clients'), '/billing', 'billing.view'],
    [copy('Pricing', 'clients'), '/pricing', 'pricing.view'],
    [copy('Marketing', 'clients'), '/marketing', 'analytics.view'],
    [copy('Commerce', 'clients'), '/commerce', 'analytics.view'],
    [copy('Web analytics', 'clients'), '/analytics', 'analytics.view'],
    [copy('Activity', 'clients'), '/activity', 'activity.view'],
    [copy('Audit history', 'clients'), '/audit', 'audit.view'],
    [copy('Integrations', 'clients'), '/integrations', 'integrations.view'],
  ] as const
  return (
    <>
      <nav
        aria-label={copy('Client modules', 'clients')}
        className="client-navigation"
      >
        {links
          .filter(
            ([, , permission]) =>
              hasPermission(grants, {
                permission,
                scope: permission === 'audit.view' ? 'global' : 'client',
                clientID,
              }) &&
              (permission !== 'audit.view' ||
                hasPermission(grants, {
                  permission: 'clients.view',
                  scope: 'client',
                  clientID,
                })),
          )
          .map(([label, path]) => (
            <NavLink
              key={path}
              to={base + path}
              end={path === ''}
              className={({ isActive }) =>
                isActive ? 'client-tab is-active' : 'client-tab'
              }
            >
              {label}
            </NavLink>
          ))}
      </nav>
      {websiteID ? <WebsiteNavigation clientID={clientID} /> : null}
    </>
  )
}
