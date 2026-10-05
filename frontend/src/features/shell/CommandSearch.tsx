import { copy, useLocale } from '../../i18n/index'
import { useEffect, useId, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { Dialog } from '../../components/ui'
import { visibleDestinations } from './navigation'
import { useClients } from '../clients/hooks'
import { canListClients, defaultFilter } from '../clients/models'
import { hasPermission } from '../auth/permissions'
import * as service from '../clients/service'

export function CommandSearch() {
  useLocale()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((previous) => !previous)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])
  return (
    <>
      <button
        className="command-trigger"
        aria-label={copy('Search workspace', 'common')}
        onClick={() => setOpen(true)}
      >
        <FontAwesomeIcon icon={faMagnifyingGlass} aria-hidden="true" />
        <span className="hidden xl:inline">
          {copy('Find or go to…', 'common')}
        </span>
        <kbd className="hidden sm:inline">{copy('⌘ / Ctrl K', 'common')}</kbd>
      </button>
      <Commands open={open} onClose={() => setOpen(false)} />
    </>
  )
}
function Commands({ open, onClose }: { open: boolean; onClose: () => void }) {
  useLocale()
  const operation = useClients()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [search, setSearch] = useState('')
  const [queryText, setQueryText] = useState('')
  const [selected, setSelected] = useState(0)
  const listID = useId()
  const grants = operation.auth.session?.user.permissions ?? []
  useEffect(() => {
    const timer = window.setTimeout(() => setQueryText(search.trim()), 200)
    return () => window.clearTimeout(timer)
  }, [search])
  const query = useQuery({
    queryKey: [...operation.key, 'command-search', queryText],
    queryFn: ({ signal }) =>
      operation.read(() =>
        service.clients({ ...defaultFilter, q: queryText }, '', signal),
      ),
    enabled: open && canListClients(grants) && queryText.length >= 2,
    staleTime: 15_000,
  })
  const pages = visibleDestinations(grants).map((item) => ({
    label: copy(item.label, 'common'),
    path: item.path,
    context: copy('Page', 'common'),
  }))
  if (hasPermission(grants, { permission: 'clients.create', scope: 'global' }))
    pages.push({
      label: copy('Create client', 'common'),
      path: '/app/clients/new',
      context: copy('Action', 'common'),
    })
  const clientID = /^\/app\/clients\/([0-9a-f-]{36})(?:\/|$)/.exec(
    pathname,
  )?.[1]
  if (clientID) {
    for (const [label, path, permission] of [
      [copy('Websites', 'common'), 'websites', 'clients.view'],
      [copy('Tasks', 'common'), 'tasks', 'tasks.view'],
      [copy('Planning', 'common'), 'plans', 'planning.view'],
      [copy('Reminders', 'common'), 'reminders', 'reminders.view'],
      [copy('Finance', 'common'), 'billing', 'billing.view'],
      [copy('Pricing', 'common'), 'pricing', 'pricing.view'],
      [copy('Web analytics', 'common'), 'analytics', 'analytics.view'],
      [copy('Commerce', 'common'), 'commerce', 'analytics.view'],
      [copy('Marketing', 'common'), 'marketing', 'analytics.view'],
    ] as const) {
      if (hasPermission(grants, { permission, scope: 'client', clientID }))
        pages.push({
          label,
          path: `/app/clients/${clientID}/${path}`,
          context: copy('Current client', 'common'),
        })
    }
  }
  const results = [
    ...pages.filter((item) =>
      item.label.toLowerCase().includes(search.trim().toLowerCase()),
    ),
    ...(queryText === search.trim() && queryText.length >= 2 && !query.isError
      ? (query.data?.data.map((item) => ({
          label: item.name,
          path: `/app/clients/${item.id}`,
          context: copy('Client', 'common'),
        })) ?? [])
      : []),
  ]
  const active = Math.min(selected, Math.max(0, results.length - 1))
  useEffect(() => {
    if (open)
      document
        .getElementById(`${listID}-${selected}`)
        ?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, listID, open])
  function go(path: string) {
    onClose()
    setSearch('')
    setSelected(0)
    navigate(path)
  }
  return (
    <Dialog
      open={open}
      eyebrow={copy('Workspace search', 'common')}
      title={copy('Find your next destination', 'common')}
      description={copy(
        'Pages, current client modules and authorized active clients. Search clients by name with at least two characters.',
        'common',
      )}
      onClose={onClose}
    >
      <div className="command-content">
        <input
          className="ui-input"
          type="search"
          aria-label={copy('Search pages and clients', 'common')}
          placeholder={copy('Client name or destination…', 'common')}
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listID}
          aria-activedescendant={
            results.length ? `${listID}-${active}` : undefined
          }
          maxLength={100}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setSelected(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setSelected(
                results.length
                  ? (active +
                      (event.key === 'ArrowDown' ? 1 : results.length - 1)) %
                      results.length
                  : 0,
              )
            }
            if (event.key === 'Enter' && results[active]) {
              event.preventDefault()
              go(results[active].path)
            }
          }}
        />
        <ul
          id={listID}
          role="listbox"
          aria-label={copy('Destinations', 'common')}
          className="command-results"
        >
          {results.map((item, index) => (
            <li
              key={item.path}
              role="option"
              id={`${listID}-${index}`}
              aria-selected={active === index}
              className={active === index ? 'is-selected' : ''}
            >
              <button tabIndex={-1} onClick={() => go(item.path)}>
                <span>{item.label}</span>
                <span className="text-[0.625rem] text-muted">
                  {item.context}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {open &&
        queryText.length >= 2 &&
        canListClients(grants) &&
        query.isFetching ? (
          <p role="status" className="text-xs text-muted">
            {copy('Searching authorized clients…', 'common')}
          </p>
        ) : null}
        {query.isError ? (
          <p role="status" className="text-xs text-danger-ink">
            {copy(
              'Client search is unavailable. Use the Clients page to retry.',
              'common',
            )}
          </p>
        ) : null}
        {!results.length ? (
          <p className="py-4 text-sm text-muted">
            {copy('No matching destinations.', 'common')}
          </p>
        ) : null}
        <div className="flex items-center justify-between border-t border-line pt-3 text-[0.625rem] text-muted">
          <span>{copy('↑ ↓ Select · Enter Open · Esc Close', 'common')}</span>
          <button
            className="min-h-8 px-2 text-xs underline underline-offset-4"
            onClick={onClose}
          >
            {copy('Close search', 'common')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
