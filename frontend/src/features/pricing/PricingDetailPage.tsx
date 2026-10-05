import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, buttonStyles, PageSkeleton } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { usePricing } from './hooks'
import { PricingHeader, PricingError, Terms, Window, Pager } from './Shared'
import { pagePath } from './models'
import { CopyForm } from './CopyForm'
import * as api from './service'
export function PricingDetailPage() {
  const { id = '', sheetID = '', versionID = '' } = useParams()
  return (
    <Detail
      key={id + ':' + sheetID + ':' + versionID}
      clientID={id}
      sheetID={sheetID}
      versionID={versionID}
    />
  )
}
function Detail({
  clientID,
  sheetID,
  versionID,
}: {
  clientID: string
  sheetID: string
  versionID: string
}) {
  const op = usePricing(clientID),
    [history, setHistory] = useState(['']),
    cursor = history.at(-1)!
  const sheet = useQuery({
    queryKey: [...op.key, 'detail', sheetID],
    queryFn: ({ signal }) =>
      op.read(() =>
        api.detail(clientID, sheetID, op.permissions.manage, signal),
      ),
    enabled: op.permissions.view,
  })
  const selected = useQuery({
    queryKey: [...op.key, 'version', sheetID, versionID],
    queryFn: ({ signal }) =>
      op.read(() =>
        api.version(
          clientID,
          sheetID,
          versionID,
          op.permissions.manage,
          signal,
        ),
      ),
    enabled: op.permissions.view && !!versionID,
  })
  const versions = useQuery({
    queryKey: [...op.key, 'history', sheetID, cursor],
    queryFn: ({ signal }) =>
      op.read(() =>
        api.versions(clientID, sheetID, op.permissions.manage, cursor, signal),
      ),
    enabled: op.permissions.view && !!sheet.data && !sheet.isError,
  })
  if (!op.permissions.view) return <AccessDenied />
  const v = versionID
      ? selected.isError
        ? undefined
        : selected.data
      : sheet.isError
        ? undefined
        : sheet.data?.latest_version,
    busy = sheet.isFetching || (!!versionID && selected.isFetching)
  const reload = () => {
    void op.cache.invalidateQueries({ queryKey: op.key })
  }
  return (
    <section>
      <PricingHeader title="Pricing agreement" operation={op}>
        <Button disabled={busy} onClick={reload}>
          Refresh agreement
        </Button>
        {op.permissions.manage &&
        op.writable &&
        sheet.data &&
        !sheet.isError &&
        !busy ? (
          <Link
            className={buttonStyles({ variant: 'primary' })}
            to={pagePath(clientID, sheetID) + '/new-version'}
          >
            Create new version
          </Link>
        ) : null}
      </PricingHeader>
      {sheet.isPending ? (
        <PageSkeleton label="Loading agreement…" />
      ) : sheet.isError ? (
        <PricingError error={sheet.error} retry={reload} />
      ) : (
        <>
          {versionID && selected.isPending ? (
            <PageSkeleton label="Loading retained version…" />
          ) : versionID && selected.isError ? (
            <PricingError error={selected.error} retry={reload} />
          ) : v ? (
            <>
              <article className="form-section">
                <p className="eyebrow">
                  Version {v.revision} · Latest version {sheet.data.revision}
                </p>
                <h2 className="mt-2 break-words text-xl font-semibold">
                  {v.title}
                </h2>
                <div className="mt-3">
                  <Window version={v} />
                </div>
                <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted">
                  {v.note || 'No pricing note.'}
                </p>
                <p className="mt-3 text-xs text-muted">
                  Retained {new Date(v.created_at).toLocaleString()}. Historical
                  lines and original dates are read only.
                </p>
                {versionID ? (
                  <Link
                    className="mt-3 inline-block text-sm underline"
                    to={pagePath(clientID, sheetID)}
                  >
                    Open latest version
                  </Link>
                ) : null}
              </article>
              <Terms calculation={v} manage={op.permissions.manage} />
              {op.permissions.copy ? (
                <CopyForm
                  key={
                    JSON.stringify(op.key) +
                    ':' +
                    v.id +
                    ':' +
                    sheet.data.revision
                  }
                  operation={op}
                  version={v}
                  revision={sheet.data.revision}
                  checking={busy}
                />
              ) : null}
            </>
          ) : null}
          <section className="mt-6">
            <h2 className="text-lg font-semibold">Version history</h2>
            <p className="mt-1 text-xs text-muted">
              Every version is retained. Latest-first within each page; use
              pagination to inspect more versions.
            </p>
            {versions.isPending ? (
              <PageSkeleton label="Loading version history…" />
            ) : versions.isError ? (
              <PricingError
                error={versions.error}
                retry={() => void versions.refetch()}
              />
            ) : (
              <>
                <ol className="mt-4 grid gap-3">
                  {[...versions.data.data]
                    .sort((a, b) =>
                      BigInt(a.revision) > BigInt(b.revision) ? -1 : 1,
                    )
                    .map((r) => (
                      <li
                        key={r.id}
                        className="form-section"
                      >
                        <Link
                          className="break-words font-semibold underline underline-offset-4"
                          to={pagePath(clientID, sheetID) + '/versions/' + r.id}
                        >
                          Version {r.revision} · {r.title}
                        </Link>
                        <Window version={r} />
                      </li>
                    ))}
                </ol>
                <Pager
                  name="Pricing versions"
                  history={history}
                  next={versions.data.page.next_cursor}
                  busy={versions.isFetching}
                  onChange={setHistory}
                />
              </>
            )}
          </section>
        </>
      )}
    </section>
  )
}
