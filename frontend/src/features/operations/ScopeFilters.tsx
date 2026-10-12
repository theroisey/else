import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from '../../lib/validation'
import { APIError, authenticatedJSON } from '../../services/authenticated'
import { Button, SelectField, TextField } from '../../components/ui'
import { copy } from '../../i18n'
import { hasPermission } from '../auth/permissions'
import { useRecordOperations } from '../auth/useRecordOperations'
import * as clients from '../clients/service'
import * as websites from '../websites/service'
import { checked, pagination, uuid } from './models'
import { OperationsError } from './Shared'
export interface Scope {
  brand: string
  website: string
  employee: string
}
export function ScopeFilters({
  value,
  onChange,
  fixedBrand,
  sites = false,
}: {
  value: Scope
  onChange: (v: Scope) => void
  fixedBrand?: string | undefined
  sites?: boolean
}) {
  const op = useRecordOperations('operations', fixedBrand)
  const [open, setOpen] = useState(false)
  const clientAccess = (op.auth.session?.user.permissions ?? []).some(
    (v) => v.permission === 'clients.view',
  )
  const t = (s: string) => copy(s, 'operations')
  const [search, setSearch] = useState('')
  const [brandCursor, setBrandCursor] = useState('')
  const [personCursor, setPersonCursor] = useState('')
  const [siteCursor, setSiteCursor] = useState('')
  const brand = fixedBrand ?? value.brand
  const team = ['staff.manage', 'staff.read_team'].some((permission) =>
    hasPermission(op.auth.session?.user.permissions ?? [], {
      permission,
      scope: 'global',
    }),
  )
  const brands = useQuery({
    queryKey: [...op.key, 'filter-brands', search, brandCursor],
    queryFn: ({ signal }) =>
      op.read(() =>
        clients.clients(
          { q: search, status: 'all', tag: '', sort: 'id' },
          brandCursor,
          signal,
        ),
      ),
    enabled: open && !fixedBrand && clientAccess,
  })
  const people = useQuery({
    queryKey: [...op.key, 'filter-people', brand, personCursor],
    enabled: open && team,
    queryFn: ({ signal }) =>
      op.read(async () => {
        const q = new URLSearchParams({ limit: '25' })
        if (brand) q.set('client_id', brand)
        if (personCursor) q.set('cursor', personCursor)
        const r = checked(
          z
            .object({
              data: z
                .array(
                  z
                    .object({ id: uuid, display_name: z.string().max(100) })
                    .strict(),
                )
                .max(25),
              page: pagination,
            })
            .strict(),
          await authenticatedJSON(`/api/v1/operations-people?${q}`, { signal }),
        )
        if (
          r.data.some(
            (v, i) =>
              (personCursor && v.id <= personCursor) ||
              (i > 0 && v.id <= r.data[i - 1]!.id),
          ) ||
          (r.page.next_cursor !== null &&
            r.page.next_cursor !== r.data.at(-1)?.id)
        )
          throw new APIError(0, 'invalid_response')
        return r
      }),
  })
  const siteRows = useQuery({
    queryKey: [...op.key, 'filter-sites', brand, siteCursor],
    enabled: open && !!brand && sites,
    queryFn: ({ signal }) =>
      op.read(() => websites.list(brand, siteCursor, 'all', signal)),
  })
  const pages = (
    cursor: string,
    next: string | null,
    set: (v: string) => void,
  ) => (
    <div className="mt-2 flex flex-wrap gap-3">
      {cursor ? (
        <Button variant="text" onClick={() => set('')}>
          {t('First page')}
        </Button>
      ) : null}
      {next ? (
        <Button variant="text" onClick={() => set(next)}>
          {t('Next page')}
        </Button>
      ) : null}
    </div>
  )
  if (!clientAccess && !team) return null
  return (
    <details className="mb-5" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-sm">
        {t('Filter by brand and team')}
      </summary>
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {!fixedBrand ? (
          <div>
            <TextField
              label={t('Find brand')}
              value={search}
              maxLength={100}
              onChange={(e) => {
                setSearch(e.target.value)
                setBrandCursor('')
              }}
            />
            <SelectField
              label={t('Brand')}
              value={brand}
              onChange={(e) => {
                onChange({ brand: e.target.value, website: '', employee: '' })
                setPersonCursor('')
                setSiteCursor('')
              }}
            >
              <option value="">{t('All authorized brands')}</option>
              {brand && !brands.data?.data.some((v) => v.id === brand) ? (
                <option value={brand}>{t('Selected brand')}</option>
              ) : null}
              {brands.data?.data.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </SelectField>
            {pages(
              brandCursor,
              brands.data?.page.next_cursor ?? null,
              setBrandCursor,
            )}
            {brands.isError ? (
              <OperationsError
                error={brands.error}
                retry={() => {
                  void brands.refetch()
                }}
              />
            ) : null}
          </div>
        ) : null}
        {team ? (
          <div>
            <SelectField
              label={t('Employee')}
              value={value.employee}
              onChange={(e) => onChange({ ...value, employee: e.target.value })}
            >
              <option value="">{t('All authorized employees')}</option>
              {value.employee &&
              !people.data?.data.some((v) => v.id === value.employee) ? (
                <option value={value.employee}>{t('Selected employee')}</option>
              ) : null}
              {people.data?.data.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.display_name}
                </option>
              ))}
            </SelectField>
            {pages(
              personCursor,
              people.data?.page.next_cursor ?? null,
              setPersonCursor,
            )}
            {people.isError ? (
              <OperationsError
                error={people.error}
                retry={() => {
                  void people.refetch()
                }}
              />
            ) : null}
          </div>
        ) : null}
        {sites && brand ? (
          <div>
            <SelectField
              label={t('Website')}
              value={value.website}
              onChange={(e) => onChange({ ...value, website: e.target.value })}
            >
              <option value="">{t('All websites')}</option>
              {value.website &&
              !siteRows.data?.data.some((v) => v.id === value.website) ? (
                <option value={value.website}>{t('Selected website')}</option>
              ) : null}
              {siteRows.data?.data.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.domain}
                </option>
              ))}
            </SelectField>
            {pages(
              siteCursor,
              siteRows.data?.page.next_cursor ?? null,
              setSiteCursor,
            )}
            {siteRows.isError ? (
              <OperationsError
                error={siteRows.error}
                retry={() => {
                  void siteRows.refetch()
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  )
}
