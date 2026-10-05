import { NavLink } from 'react-router'
import { useAuth } from '../auth/auth-context'
import { hasPermission } from '../auth/permissions'

export function ClientNavigation({ clientID }: { clientID: string }) {
  const grants = useAuth().session?.user.permissions ?? []
  const base = `/app/clients/${clientID}`
  const links = [
    ['Overview', '', 'clients.view'], ['Profile', '/profile', 'clients.view'],
    ['Tasks', '/tasks', 'tasks.view'], ['Planning', '/plans', 'planning.view'],
    ['Reminders', '/reminders', 'reminders.view'], ['Finance', '/billing', 'billing.view'],
    ['Pricing', '/pricing', 'pricing.view'], ['Marketing', '/marketing', 'analytics.view'],
    ['Commerce', '/commerce', 'analytics.view'], ['Web analytics', '/analytics', 'analytics.view'],
    ['Activity', '/activity', 'activity.view'], ['Audit history', '/audit', 'audit.view'],
    ['Integrations', '/integrations', 'integrations.view'],
  ] as const
  return <nav aria-label="Client modules" className="client-navigation">{links.filter(([, , permission]) => hasPermission(grants, { permission, scope: permission === 'audit.view' ? 'global' : 'client', clientID }) && (permission !== 'audit.view' || hasPermission(grants, { permission: 'clients.view', scope: 'client', clientID }))).map(([label, path]) => <NavLink key={path} to={base + path} end={path === ''} className={({ isActive }) => isActive ? 'client-tab is-active' : 'client-tab'}>{label}</NavLink>)}</nav>
}
