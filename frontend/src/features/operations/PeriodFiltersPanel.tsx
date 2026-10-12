import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, TextField, SelectField } from '../../components/ui'
import { copy, useLocale } from '../../i18n'
import { useRecordOperations } from '../auth/useRecordOperations'
import { currencies, labels, states } from '../billing/models'
import * as api from './commercial-service'
import { OperationsError } from './Shared'
const t = (v: string) => copy(v, 'operations')
export function PeriodFiltersPanel({
  client,
  value,
  onApply,
}: {
  client: string
  value: api.PeriodFilters
  onApply: (v: api.PeriodFilters) => void
}) {
  useLocale()
  const op = useRecordOperations('agreements', client)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [cursor, setCursor] = useState('')
  const partners = useQuery({
    queryKey: [...op.key, 'filter-partners', cursor],
    queryFn: ({ signal }) =>
      op.read(() => api.partners(client, cursor, signal)),
    enabled: open,
  })
  const set = (key: keyof api.PeriodFilters, value: string) =>
    setDraft((v) => ({ ...v, [key]: value }))
  return (
    <details
      className="mb-5 border-b border-line pb-4"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer py-2 text-sm font-medium">
        {t('Period filters')}
      </summary>
      {open ? (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault()
            onApply(draft)
          }}
        >
          <div className="grid gap-4 md:grid-cols-3">
            <TextField
              label={t('Find service')}
              value={draft.q}
              maxLength={100}
              onChange={(e) => set('q', e.target.value)}
            />
            <SelectField
              label={t('Service type')}
              value={draft.service_type}
              onChange={(e) => set('service_type', e.target.value)}
            >
              <option value="">{t('All services')}</option>
              {[
                'software_maintenance',
                'software_development',
                'advertising_consulting',
                'other',
              ].map((v) => (
                <option key={v} value={v}>
                  {t(v)}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={t('Currency')}
              value={draft.currency}
              onChange={(e) => set('currency', e.target.value)}
            >
              <option value="">{t('All currencies')}</option>
              {currencies.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={t('Contract collector')}
              value={draft.collector}
              onChange={(e) => set('collector', e.target.value)}
            >
              <option value="">{t('All collectors')}</option>
              <option value="roise">ROISE</option>
              <option value="partner">{t('Advertising partner')}</option>
            </SelectField>
            <SelectField
              label={t('Actual payment collector')}
              value={draft.payment_collector ?? ''}
              onChange={(e) => set('payment_collector', e.target.value)}
            >
              <option value="">{t('All collectors')}</option>
              <option value="roise">ROISE</option>
              <option value="partner">{t('Advertising partner')}</option>
            </SelectField>
            <SelectField
              label={t('Payment status')}
              value={draft.payment_status}
              onChange={(e) => set('payment_status', e.target.value)}
            >
              <option value="">{t('All statuses')}</option>
              {states.map((v) => (
                <option key={v} value={v}>
                  {copy(labels[v], 'billing')}
                </option>
              ))}
            </SelectField>
            <div>
              <SelectField
                label={t('Advertising partner')}
                value={draft.partner_id}
                onChange={(e) => set('partner_id', e.target.value)}
              >
                <option value="">{t('All partners')}</option>
                <option value="none">{t('No partner')}</option>
                {partners.data?.data.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
                {draft.partner_id &&
                draft.partner_id !== 'none' &&
                !partners.data?.data.some((v) => v.id === draft.partner_id) ? (
                  <option value={draft.partner_id}>
                    {t('Selected partner')}
                  </option>
                ) : null}
              </SelectField>
              {partners.data?.page.next_cursor ? (
                <Button
                  variant="text"
                  onClick={() => setCursor(partners.data!.page.next_cursor!)}
                >
                  {t('More partners')}
                </Button>
              ) : null}
              {cursor ? (
                <Button variant="text" onClick={() => setCursor('')}>
                  {t('First page')}
                </Button>
              ) : null}
            </div>
            <TextField
              label={t('From billing date')}
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(e) => set('from', e.target.value)}
            />
            <TextField
              label={t('To billing date')}
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(e) => set('to', e.target.value)}
            />
          </div>
          {partners.isError ? (
            <OperationsError
              error={partners.error}
              retry={() => {
                void partners.refetch()
              }}
            />
          ) : null}
          <div className="mt-4 flex gap-3">
            <Button type="submit">{t('Apply filters')}</Button>
            <Button
              onClick={() => {
                const reset = {
                  q: '',
                  service_type: '',
                  currency: '',
                  collector: '',
                  partner_id: '',
                  payment_status: '',
                  from: '',
                  to: '',
                }
                setDraft(reset)
                setCursor('')
                onApply(reset)
              }}
            >
              {t('Clear filters')}
            </Button>
          </div>
        </form>
      ) : null}
    </details>
  )
}
