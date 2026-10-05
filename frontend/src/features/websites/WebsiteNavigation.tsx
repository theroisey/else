import { copy, useLocale } from '../../i18n/index'
import { Link, NavLink, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useClients } from '../clients/hooks'
import { hasPermission } from '../auth/permissions'
import * as api from './service'

export function WebsiteNavigation({ clientID }: { clientID: string }) {
  useLocale()
  const { websiteID = '' } = useParams()
  const navigate = useNavigate()
  const operation = useClients()
  const grants = operation.auth.session?.user.permissions ?? []
  const view = hasPermission(grants, {
    permission: 'clients.view',
    scope: 'client',
    clientID,
  })
  const current = useQuery({
    queryKey: [...operation.key, 'website', clientID, websiteID],
    queryFn: ({ signal }) =>
      operation.read(() => api.detail(clientID, websiteID, signal)),
    enabled: !!websiteID && view,
  })
  const list = useQuery({
    queryKey: [...operation.key, 'website-switcher', clientID],
    queryFn: ({ signal }) =>
      operation.read(() => api.list(clientID, '', 'active', signal)),
    enabled: !!websiteID && view,
  })
  const base = api.websiteBase(clientID, websiteID)
  const links = [
    [copy('Overview', 'websites'), '', 'clients.view'],
    [copy('Web analytics', 'websites'), '/analytics', 'analytics.view'],
    [copy('Marketing', 'websites'), '/marketing', 'analytics.view'],
    [copy('Commerce', 'websites'), '/commerce', 'analytics.view'],
    [copy('Integrations', 'websites'), '/integrations', 'integrations.view'],
    [copy('Activity', 'websites'), '/activity', 'activity.view'],
  ] as const
  return (
    <div className="website-context">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">{copy('Website workspace', 'websites')}</p>
          <p className="mt-1 break-all font-semibold">
            {current.data?.domain ||
              current.data?.name ||
              copy('Website', 'websites')}
          </p>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
          <label className="website-switcher">
            <span className="sr-only">
              {copy('Switch website', 'websites')}
            </span>
            <select
              value={websiteID}
              disabled={!list.data || current.isFetching}
              onChange={(e) =>
                navigate(api.websiteBase(clientID, e.target.value))
              }
            >
              {current.data &&
              !list.data?.data.some((w) => w.id === websiteID) ? (
                <option value={websiteID}>
                  {current.data.domain || current.data.name}
                </option>
              ) : null}
              {list.data?.data.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.domain || w.name}
                  {w.is_primary ? copy(' · Primary', 'websites') : ''}
                </option>
              ))}
            </select>
          </label>
          <Link
            className="text-xs font-semibold underline underline-offset-4"
            to={`/app/clients/${clientID}/websites`}
          >
            {copy('All websites', 'websites')}
          </Link>
        </div>
      </div>
      <nav
        aria-label={copy('Website modules', 'websites')}
        className="client-navigation mt-3 mb-0"
      >
        {links
          .filter(([, , permission]) =>
            hasPermission(grants, { permission, scope: 'client', clientID }),
          )
          .map(([label, path]) => (
            <NavLink
              to={base + path}
              end={path === ''}
              key={path}
              className={({ isActive }) =>
                isActive ? 'client-tab is-active' : 'client-tab'
              }
            >
              {label}
            </NavLink>
          ))}
      </nav>
      {list.data?.page.next_cursor ? (
        <p className="mt-2 text-xs text-muted">
          {copy(
            'Showing the first 25 active websites. Open All websites to browse the portfolio.',
            'websites',
          )}
        </p>
      ) : null}
      {current.isError || list.isError ? (
        <p role="alert" className="mt-2 text-xs text-danger-ink">
          {copy(
            'Unable to load website context. Reload this page.',
            'websites',
          )}
        </p>
      ) : null}
    </div>
  )
}
