import { Link } from 'react-router'
import { copy } from '../../i18n'
import type { Overview } from '../overview/models'
import { RequestState } from './Shared'
import { states, labels } from './models'
import { time } from './time'
export function BrandOperations({
  client,
  data,
}: {
  client: string
  data: NonNullable<Overview['operations']>
}) {
  const t = (s: string) => copy(s, 'operations')
  return (
    <section className="mb-8 border-b border-line pb-7">
      <div className="flex flex-wrap gap-x-8 gap-y-4 border-y border-line py-4">
        {states
          .filter((s) => !['approved', 'cancelled', 'rejected'].includes(s))
          .map((s) => (
            <Link key={s} to={`/app/clients/${client}/requests?status=${s}`}>
              <span className="block font-display text-2xl tabular-nums">
                {data.counts[s]}
              </span>
              <span className="text-xs text-muted">{t(labels[s])}</span>
            </Link>
          ))}
      </div>
      <div className="mt-6 grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div>
          <h2 className="section-heading">{t('Recent request activity')}</h2>
          {data.requests.items.length ? (
            data.requests.items.map((r) => (
              <Link
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-4"
                to={`/app/clients/${client}/requests/${r.id}`}
              >
                <div>
                  <p className="break-words text-sm font-medium">{r.title}</p>
                  <p className="mt-1 text-xs text-muted">
                    {r.requester_name} · {time(r.updated_at)}
                  </p>
                </div>
                <RequestState status={r.status} />
              </Link>
            ))
          ) : (
            <p className="py-4 text-sm text-muted">
              {t('No requests require attention.')}
            </p>
          )}
          <Link
            className="mt-4 inline-block text-sm underline underline-offset-4"
            to={`/app/clients/${client}/requests`}
          >
            {t('View all requests')}
          </Link>
        </div>
        <aside>
          <h2 className="eyebrow">{t('Assigned team')}</h2>
          {data.staff.items.length ? (
            data.staff.items.map((s) => (
              <div key={s.id} className="border-b border-line py-3">
                <p className="text-sm">{s.display_name}</p>
                <p className="mt-1 break-words text-xs text-muted">
                  {s.team_name}
                  {s.responsibility ? ' · ' + s.responsibility : ''}
                </p>
              </div>
            ))
          ) : (
            <p className="mt-3 text-sm text-muted">
              {t('No team assigned to this brand.')}
            </p>
          )}
          {data.staff.has_more ? (
            <p className="mt-3 text-xs text-muted">
              {t('Additional team members are assigned.')}
            </p>
          ) : null}
          <h2 className="eyebrow mt-6">{t('Websites')}</h2>
          {data.websites.items.map((w) => (
            <Link
              className="block border-b border-line py-3"
              key={w.id}
              to={`/app/clients/${client}/websites/${w.id}`}
            >
              <p className="text-sm">{w.name}</p>
              <p className="mt-1 break-words text-xs text-muted">{w.domain}</p>
            </Link>
          ))}
          {!data.websites.items.length ? (
            <p className="mt-3 text-sm text-muted">
              {t('No websites recorded for this brand.')}
            </p>
          ) : null}
          <Link
            className="mt-4 inline-block text-xs underline underline-offset-4"
            to={`/app/clients/${client}/websites`}
          >
            {t('View websites')}
          </Link>
        </aside>
      </div>
    </section>
  )
}
