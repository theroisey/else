import { APIError } from '../../services/authenticated'
import { time } from './time'
import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  SelectField,
  TextField,
  PageSkeleton,
  buttonStyles,
} from '../../components/ui'
import { copy, useLocale } from '../../i18n'
import { useRecordOperations } from '../auth/useRecordOperations'
import { hasPermission } from '../auth/permissions'
import * as clients from '../clients/service'
import * as api from './team-service'
import { OperationsHeader, OperationsError } from './Shared'
import type { Team } from './team-service'
const t = (key: string) => copy(key, 'operations')
export function TeamPage() {
  useLocale()
  const { teamID } = useParams()
  return teamID ? <TeamDetail key={teamID} id={teamID} /> : <TeamList />
}
function TeamList() {
  const op = useRecordOperations('team')
  const [cursor, setCursor] = useState('')
  const [creating, setCreating] = useState(false)
  const owner = hasPermission(op.auth.session?.user.permissions ?? [], {
    permission: 'staff.manage',
    scope: 'global',
  })
  const query = useQuery({
    queryKey: [...op.key, 'list', cursor],
    queryFn: ({ signal }) => op.read(() => api.list(cursor, signal)),
  })
  return (
    <section>
      <OperationsHeader title={t('Team')}>
        {owner ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('Create team')}
          </Button>
        ) : null}
      </OperationsHeader>
      {query.isPending ? (
        <PageSkeleton label={t('Loading team…')} />
      ) : query.isError ? (
        <OperationsError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : (
        <>
          <ul>
            {query.data.data.map((team) => (
              <li key={team.id} className="border-b border-line py-5">
                <Link
                  to={`/app/team/${team.id}`}
                  className="font-display text-2xl"
                >
                  {team.name}
                </Link>
                <p className="mt-2 text-sm text-muted">
                  {t('Team leader')} · {team.leader_name}
                </p>
              </li>
            ))}
          </ul>
          {!query.data.data.length ? (
            <p className="py-8 text-muted">
              {t('No teams are available in your scope.')}
            </p>
          ) : null}
          <div className="mt-5 flex gap-3">
            {cursor ? (
              <Button onClick={() => setCursor('')}>{t('First page')}</Button>
            ) : null}
            {query.data.page.next_cursor ? (
              <Button onClick={() => setCursor(query.data!.page.next_cursor!)}>
                {t('More teams')}
              </Button>
            ) : null}
          </div>
        </>
      )}
      {creating ? <TeamForm onClose={() => setCreating(false)} /> : null}
    </section>
  )
}
function TeamDetail({ id }: { id: string }) {
  const op = useRecordOperations('team', id)
  const [memberCursor, setMemberCursor] = useState('')
  const [brandCursor, setBrandCursor] = useState('')
  const [form, setForm] = useState<'profile' | 'member' | 'assignment' | null>(
    null,
  )
  const [showHistory, setShowHistory] = useState(false)
  const [historyBefore, setHistoryBefore] = useState('')
  const history = useQuery({
    queryKey: [...op.key, 'history', historyBefore],
    queryFn: ({ signal }) =>
      op.read(() => api.history(id, historyBefore, signal)),
    enabled: showHistory,
  })
  const owner = hasPermission(op.auth.session?.user.permissions ?? [], {
    permission: 'staff.manage',
    scope: 'global',
  })
  const query = useQuery({
    queryKey: [...op.key, 'detail'],
    queryFn: ({ signal }) => op.read(() => api.read(id, signal)),
    refetchInterval: 30000,
  })
  const members = useQuery({
    queryKey: [...op.key, 'members', memberCursor],
    queryFn: ({ signal }) =>
      op.read(() => api.members(id, memberCursor, signal)),
    enabled: query.isSuccess,
  })
  const brands = useQuery({
    queryKey: [...op.key, 'assignments', brandCursor],
    queryFn: ({ signal }) =>
      op.read(() => api.assignments(id, brandCursor, signal)),
    enabled: query.isSuccess,
  })
  if (query.isPending) return <PageSkeleton label={t('Loading team…')} />
  if (query.isError)
    return (
      <OperationsError
        error={query.error}
        retry={() => {
          void query.refetch()
        }}
      />
    )
  const team = query.data
  const canAssign = (op.auth.session?.user.permissions ?? []).some(
    (g) => g.permission === 'staff.assign_brands',
  )
  return (
    <section>
      <OperationsHeader title={team.name}>
        <Link to="/app/team" className={buttonStyles()}>
          {t('All teams')}
        </Link>
        {owner && !team.archived_at ? (
          <>
            <Button onClick={() => setForm('profile')}>{t('Edit team')}</Button>
            <Button onClick={() => setForm('member')}>
              {t('Add employee')}
            </Button>
          </>
        ) : null}
        {canAssign && !team.archived_at ? (
          <Button variant="primary" onClick={() => setForm('assignment')}>
            {t('Assign brand')}
          </Button>
        ) : null}
      </OperationsHeader>
      <p className="mb-7 text-sm text-muted">
        {t('Team leader')} · {team.leader_name}
      </p>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="workspace-section">
          <h2 className="font-display text-2xl">
            {t('Advertising employees')}
          </h2>
          {members.isPending ? (
            <PageSkeleton label={t('Loading team…')} />
          ) : members.isError ? (
            <OperationsError
              error={members.error}
              retry={() => {
                void members.refetch()
              }}
            />
          ) : (
            <>
              <ul>
                {members.data.data.map((m) => (
                  <li
                    key={m.id}
                    className="flex flex-wrap justify-between gap-4 border-b border-line py-4"
                  >
                    <div>
                      <p className="font-medium">{m.display_name}</p>
                      <p className="mt-2 text-xs text-muted">
                        {t('Assigned brands')}: {m.brands} · {t('Active tasks')}
                        : {m.active_tasks} ·{' '}
                        {copy(m.status === 'active' ? 'Active' : 'Disabled')}
                      </p>
                    </div>
                    {owner && !team.archived_at ? (
                      <Button
                        size="compact"
                        disabled={op.pending}
                        onClick={() => {
                          if (
                            window.confirm(
                              t(
                                'Remove membership and its managed brand access?',
                              ),
                            )
                          )
                            void op.run(() =>
                              api.membership(id, {
                                user_id: m.user_id,
                                active: false,
                                expected_revision: team.revision,
                              }),
                            )
                        }}
                      >
                        {t('Remove employee')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {!members.data.data.length ? (
                <p className="py-6 text-muted">
                  {t('No employees assigned to this team.')}
                </p>
              ) : null}
              <div className="mt-4 flex gap-3">
                {memberCursor ? (
                  <Button onClick={() => setMemberCursor('')}>
                    {t('First page')}
                  </Button>
                ) : null}
                {members.data.page.next_cursor ? (
                  <Button
                    onClick={() =>
                      setMemberCursor(members.data!.page.next_cursor!)
                    }
                  >
                    {t('More employees')}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </section>
        <section className="workspace-section">
          <h2 className="font-display text-2xl">
            {t('Brand responsibilities')}
          </h2>
          {brands.isPending ? (
            <PageSkeleton label={t('Loading team…')} />
          ) : brands.isError ? (
            <OperationsError
              error={brands.error}
              retry={() => {
                void brands.refetch()
              }}
            />
          ) : (
            <>
              <ul>
                {brands.data.data.map((b) => (
                  <li key={b.id} className="border-b border-line py-4">
                    <Link
                      to={`/app/clients/${b.client_id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {b.brand_name}
                    </Link>
                    <p className="mt-2 text-sm">{b.display_name}</p>
                    <p className="mt-2 break-words text-xs text-muted">
                      {b.responsibility}
                    </p>
                    {hasPermission(op.auth.session?.user.permissions ?? [], {
                      permission: 'staff.assign_brands',
                      scope: 'client',
                      clientID: b.client_id,
                    }) && !team.archived_at ? (
                      <Button
                        className="mt-3"
                        size="compact"
                        disabled={op.pending}
                        onClick={() => {
                          if (
                            window.confirm(
                              t('Remove this managed brand assignment?'),
                            )
                          )
                            void op.run(() =>
                              api.assign(id, {
                                client_id: b.client_id,
                                user_id: b.user_id,
                                responsibility: '',
                                active: false,
                                expected_revision: team.revision,
                              }),
                            )
                        }}
                      >
                        {t('Remove assignment')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {!brands.data.data.length ? (
                <p className="py-6 text-muted">
                  {t('No brand responsibilities assigned.')}
                </p>
              ) : null}
              <div className="mt-4 flex gap-3">
                {brandCursor ? (
                  <Button onClick={() => setBrandCursor('')}>
                    {t('First page')}
                  </Button>
                ) : null}
                {brands.data.page.next_cursor ? (
                  <Button
                    onClick={() =>
                      setBrandCursor(brands.data!.page.next_cursor!)
                    }
                  >
                    {t('More assignments')}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </section>
      </div>
      {op.error ? (
        <p role="alert" className="mt-4 text-danger-ink">
          {copy(op.error)}
        </p>
      ) : null}
      <details
        className="mt-8 border-t border-line py-5"
        onToggle={(e) => setShowHistory(e.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm font-medium">
          {t('Leadership history')}
        </summary>
        {showHistory ? (
          history.isPending ? (
            <PageSkeleton label={t('Loading team…')} />
          ) : history.isError ? (
            <OperationsError
              error={history.error}
              retry={() => {
                void history.refetch()
              }}
            />
          ) : (
            <>
              <ul>
                {history.data.data.map((h) => (
                  <li key={h.id} className="border-b border-line py-4">
                    <p className="text-sm">
                      {h.previous_leader_name
                        ? `${h.previous_leader_name} → `
                        : ''}
                      {h.leader_name}
                    </p>
                    <p className="mt-2 text-xs text-muted">
                      {h.actor_name} · {time(h.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex gap-3">
                {historyBefore ? (
                  <Button onClick={() => setHistoryBefore('')}>
                    {t('First page')}
                  </Button>
                ) : null}
                {history.data.page.next_before ? (
                  <Button
                    onClick={() =>
                      setHistoryBefore(history.data!.page.next_before!)
                    }
                  >
                    {t('Earlier leadership changes')}
                  </Button>
                ) : null}
              </div>
            </>
          )
        ) : null}
      </details>
      {form === 'profile' ? (
        <TeamForm baseline={team} onClose={() => setForm(null)} />
      ) : null}
      {form === 'member' || form === 'assignment' ? (
        <AssignmentForm team={team} mode={form} onClose={() => setForm(null)} />
      ) : null}
    </section>
  )
}
function TeamForm({
  baseline: initial,
  onClose,
}: {
  baseline?: Team
  onClose: () => void
}) {
  const [baseline] = useState(initial)
  const op = useRecordOperations('team')
  const sent = useRef<unknown>(null)
  const [locked, setLocked] = useState(false)
  const [id] = useState(() => baseline?.id ?? crypto.randomUUID())
  const [name, setName] = useState(baseline?.name ?? '')
  const [leader, setLeader] = useState(baseline?.leader_id ?? '')
  const [cursor, setCursor] = useState('')
  const [search, setSearch] = useState('')
  const users = useQuery({
    queryKey: [...op.key, 'directory', cursor, search],
    queryFn: ({ signal }) =>
      op.read(() => api.directory(cursor, search, signal)),
  })
  return (
    <Dialog
      title={t(baseline ? 'Edit team' : 'Create team')}
      description={t('Leadership does not grant access to company finance.')}
      open
      onClose={() => {
        if (
          !op.pending &&
          (!locked ||
            window.confirm(
              t(
                'Close this form and inspect the recorded history before starting another transaction?',
              ),
            ))
        )
          onClose()
      }}
      variant="drawer"
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!leader) return
          if (!sent.current) {
            sent.current = baseline
              ? {
                  name,
                  leader_id: leader,
                  archived: false,
                  expected_revision: baseline.revision,
                }
              : { id, name, leader_id: leader }
            setLocked(true)
          }
          void op
            .run(
              () =>
                baseline
                  ? api.update(id, sent.current)
                  : api.create(sent.current),
              (error) => {
                if (error instanceof APIError && error.status === 400) {
                  sent.current = null
                  setLocked(false)
                }
              },
            )
            .then((v) => {
              if (v) onClose()
            })
        }}
      >
        <fieldset disabled={op.pending || locked} className="space-y-5">
          <TextField
            label={t('Team name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            required
          />
          <TextField
            label={t('Find employee')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setCursor('')
            }}
            maxLength={100}
          />
          <SelectField
            label={t('Team leader')}
            value={leader}
            onChange={(e) => setLeader(e.target.value)}
            required
          >
            <option value="">{t('Choose employee')}</option>
            {users.data?.data.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}
              </option>
            ))}
            {leader && !users.data?.data.some((u) => u.id === leader) ? (
              <option value={leader}>
                {baseline?.leader_name ?? t('Selected employee')}
              </option>
            ) : null}
          </SelectField>
          {users.data?.page.next_cursor ? (
            <Button onClick={() => setCursor(users.data!.page.next_cursor!)}>
              {t('More employees')}
            </Button>
          ) : null}
          {users.isError ? (
            <OperationsError
              error={users.error}
              retry={() => {
                void users.refetch()
              }}
            />
          ) : null}
        </fieldset>
        {op.error ? (
          <p role="alert" className="text-danger-ink">
            {copy(op.error)}
          </p>
        ) : null}
        <Button variant="primary" type="submit" loading={op.pending}>
          {t(
            locked
              ? 'Retry original command'
              : baseline
                ? 'Save team'
                : 'Create team',
          )}
        </Button>
        {locked ? (
          <p className="text-sm text-muted">
            {t(
              'Values are held for reconciliation. Retry sends the original command only.',
            )}
          </p>
        ) : null}
        {baseline ? (
          <Button
            variant="danger"
            disabled={op.pending || locked}
            onClick={() => {
              if (
                window.confirm(
                  t('Archive team and revoke its managed assignments?'),
                )
              )
                void op
                  .run(() =>
                    api.update(id, {
                      name: baseline.name,
                      leader_id: baseline.leader_id,
                      archived: true,
                      expected_revision: baseline.revision,
                    }),
                  )
                  .then((v) => {
                    if (v) onClose()
                  })
            }}
          >
            {t('Archive team')}
          </Button>
        ) : null}
      </form>
    </Dialog>
  )
}
function AssignmentForm({
  team: initial,
  mode,
  onClose,
}: {
  team: Team
  mode: 'member' | 'assignment'
  onClose: () => void
}) {
  const [team] = useState(initial)
  const sent = useRef<unknown>(null)
  const [locked, setLocked] = useState(false)
  const op = useRecordOperations('team', team.id)
  const [user, setUser] = useState('')
  const [client, setClient] = useState('')
  const [responsibility, setResponsibility] = useState('')
  const [cursor, setCursor] = useState('')
  const [brandCursor, setBrandCursor] = useState('')
  const [search, setSearch] = useState('')
  const directory = useQuery({
    queryKey: [...op.key, 'directory', cursor, search],
    queryFn: ({ signal }) =>
      op.read(() => api.directory(cursor, search, signal)),
    enabled: mode === 'member',
  })
  const members = useQuery({
    queryKey: [...op.key, 'members', cursor],
    queryFn: ({ signal }) =>
      op.read(() => api.members(team.id, cursor, signal)),
    enabled: mode === 'assignment',
  })
  const brands = useQuery({
    queryKey: [...op.key, 'brands', brandCursor, search],
    queryFn: ({ signal }) =>
      op.read(() =>
        clients.clients(
          { q: search, tag: '', status: 'active', sort: 'id' },
          brandCursor,
          signal,
        ),
      ),
    enabled: mode === 'assignment',
  })
  const candidates =
    mode === 'member'
      ? directory.data?.data.map((u) => ({ id: u.id, name: u.display_name }))
      : members.data?.data
          .filter((u) => u.status === 'active')
          .map((u) => ({ id: u.user_id, name: u.display_name }))
  const more =
    mode === 'member'
      ? directory.data?.page.next_cursor
      : members.data?.page.next_cursor
  const title = t(mode === 'member' ? 'Add employee' : 'Assign brand')
  return (
    <Dialog
      title={title}
      description={t(
        'Assignments control record access. Existing history is retained.',
      )}
      open
      onClose={() => {
        if (
          !op.pending &&
          (!locked ||
            window.confirm(
              t(
                'Close this form and inspect the recorded history before starting another transaction?',
              ),
            ))
        )
          onClose()
      }}
      variant="drawer"
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!user || (mode === 'assignment' && !client)) return
          if (!sent.current) {
            sent.current =
              mode === 'member'
                ? {
                    user_id: user,
                    active: true,
                    expected_revision: team.revision,
                  }
                : {
                    user_id: user,
                    client_id: client,
                    responsibility,
                    active: true,
                    expected_revision: team.revision,
                  }
            setLocked(true)
          }
          void op
            .run(
              () =>
                mode === 'member'
                  ? api.membership(team.id, sent.current)
                  : api.assign(team.id, sent.current),
              (failure) => {
                if (failure instanceof APIError && failure.status === 400) {
                  sent.current = null
                  setLocked(false)
                }
              },
            )
            .then((v) => {
              if (v) onClose()
            })
        }}
      >
        <fieldset disabled={op.pending || locked} className="space-y-5">
          <TextField
            label={t(mode === 'member' ? 'Find employee' : 'Find brand')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setCursor('')
              setBrandCursor('')
            }}
            maxLength={100}
          />
          <SelectField
            label={t('Employee')}
            value={user}
            onChange={(e) => setUser(e.target.value)}
            required
          >
            <option value="">{t('Choose employee')}</option>
            {mode === 'assignment' ? (
              <option value={team.leader_id}>
                {team.leader_name} · {t('Team leader')}
              </option>
            ) : null}
            {candidates?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
            {user &&
            user !== team.leader_id &&
            !candidates?.some((u) => u.id === user) ? (
              <option value={user}>{t('Selected employee')}</option>
            ) : null}
          </SelectField>
          {more ? (
            <Button onClick={() => setCursor(more)}>
              {t('More employees')}
            </Button>
          ) : null}
          {mode === 'assignment' ? (
            <>
              <SelectField
                label={t('Brand')}
                value={client}
                onChange={(e) => setClient(e.target.value)}
                required
              >
                <option value="">{t('Choose a brand')}</option>
                {brands.data?.data
                  .filter((b) =>
                    hasPermission(op.auth.session?.user.permissions ?? [], {
                      permission: 'staff.assign_brands',
                      scope: 'client',
                      clientID: b.id,
                    }),
                  )
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                {client && !brands.data?.data.some((b) => b.id === client) ? (
                  <option value={client}>{t('Selected brand')}</option>
                ) : null}
              </SelectField>
              {brands.data?.page.next_cursor ? (
                <Button
                  onClick={() => setBrandCursor(brands.data!.page.next_cursor!)}
                >
                  {t('More brands')}
                </Button>
              ) : null}
              <TextField
                label={t('Responsibility')}
                value={responsibility}
                onChange={(e) => setResponsibility(e.target.value)}
                maxLength={300}
              />
            </>
          ) : null}
        </fieldset>
        {directory.isError || members.isError || brands.isError ? (
          <OperationsError
            error={directory.error ?? members.error ?? brands.error}
            retry={() => {
              if (mode === 'member') void directory.refetch()
              else {
                void members.refetch()
                void brands.refetch()
              }
            }}
          />
        ) : null}
        {op.error ? (
          <p role="alert" className="text-danger-ink">
            {copy(op.error)}
          </p>
        ) : null}
        <Button type="submit" variant="primary" loading={op.pending}>
          {locked ? t('Retry original command') : title}
        </Button>
        {locked ? (
          <p className="text-sm text-muted">
            {t(
              'Values are held for reconciliation. Retry sends the original command only.',
            )}
          </p>
        ) : null}
      </form>
    </Dialog>
  )
}
