import { useState } from 'react'
import { NavLink, useLocation } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faEllipsis,
  faInbox,
  faListCheck,
} from '@fortawesome/free-solid-svg-icons'
import { Dialog } from '../../components/ui'
import { copy, useLocale } from '../../i18n'
import type { Destination } from './navigation'

const dailyPaths = ['/app', '/app/tasks', '/app/requests', '/app/clients']

/** Consume the same current-grant destinations as the desktop sidebar. */
export function MobileNavigation({
  navigation,
}: {
  navigation: Destination[]
}) {
  useLocale()
  const location = useLocation()
  const [openedAt, setOpenedAt] = useState<string | null>(null)
  const open = openedAt === location.key
  const daily = dailyPaths.flatMap((path) =>
    navigation.filter((item) => item.path === path),
  )
  const more = navigation.filter((item) => !dailyPaths.includes(item.path))
  const moreActive = more.some(
    (item) =>
      location.pathname === item.path ||
      location.pathname.startsWith(item.path + '/'),
  )

  function navigate() {
    setOpenedAt(null)
    // The dialog restores its trigger on dismissal; route navigation focuses content.
    window.requestAnimationFrame(() =>
      document
        .getElementById('workspace-content')
        ?.focus({ preventScroll: true }),
    )
  }

  return (
    <>
      <nav
        className="mobile-navigation lg:hidden"
        aria-label={copy('Application', 'common')}
      >
        {daily.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/app'}
            onClick={navigate}
            className={({ isActive }) =>
              `mobile-navigation-link ${isActive ? 'is-active' : ''}`
            }
          >
            <FontAwesomeIcon
              icon={
                item.path === '/app/tasks'
                  ? faListCheck
                  : item.path === '/app/requests'
                    ? faInbox
                    : item.icon
              }
              aria-hidden="true"
            />
            <span>
              {copy(
                item.path === '/app/tasks'
                  ? 'Tasks'
                  : item.path === '/app/requests'
                    ? 'Requests'
                    : item.label,
                'common',
              )}
            </span>
          </NavLink>
        ))}
        {more.length ? (
          <button
            type="button"
            className={`mobile-navigation-link ${moreActive ? 'is-active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-current={moreActive ? 'page' : undefined}
            onClick={() => setOpenedAt(open ? null : location.key)}
          >
            <FontAwesomeIcon icon={faEllipsis} aria-hidden="true" />
            <span>{copy('More', 'operations')}</span>
          </button>
        ) : null}
      </nav>
      <Dialog
        open={open}
        title={copy('More', 'operations')}
        description={copy('Choose a page.', 'common')}
        eyebrow={copy('Workspace', 'common')}
        variant="sheet"
        closeLabel={copy('Close navigation', 'common')}
        onClose={() => setOpenedAt(null)}
      >
        <nav
          className="grid gap-1 sm:grid-cols-2"
          aria-label={copy('Workspace', 'common')}
        >
          {more.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={navigate}
              className={({ isActive }) =>
                `sidebar-link min-h-11 ${isActive ? 'is-active' : ''}`
              }
            >
              <FontAwesomeIcon icon={item.icon} aria-hidden="true" />
              {copy(item.label, 'common')}
            </NavLink>
          ))}
        </nav>
      </Dialog>
    </>
  )
}
