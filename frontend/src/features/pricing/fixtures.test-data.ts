import {
  actorID,
  clientID,
  date,
  identity,
} from '../billing/fixtures.test-data'
import type { Profile, Version, Sheet, Snapshot, Calculation } from './models'
export { actorID, clientID }
export const sheetID = '66666666-6666-4666-8666-666666666666',
  versionID = '77777777-7777-4777-8777-777777777777',
  nextID = '88888888-8888-4888-8888-888888888888'
export const profile: Profile = {
  title: 'Synthetic pricing agreement',
  note: 'Synthetic pricing note',
  currency: 'USD',
  effective_from: '2020-02-29',
  effective_until: null,
  lines: [
    {
      description: 'Synthetic recurring service',
      kind: 'recurring',
      frequency: 'monthly',
      quantity_micros: '1500000',
      unit_price_minor: '101',
      discount_bps: '2500',
      tax_bps: '1000',
      unit_cost_minor: '7',
    },
  ],
}
export const calculation = {
  currency: 'USD' as const,
  currency_exponent: 2,
  base_minor: '152',
  discount_minor: '38',
  net_minor: '114',
  tax_minor: '11',
  total_minor: '125',
  cost_minor: '11',
  lines: [
    {
      ...profile.lines[0]!,
      position: 1,
      base_minor: '152',
      discount_minor: '38',
      net_minor: '114',
      tax_minor: '11',
      total_minor: '125',
      cost_minor: '11',
    },
  ],
}
export const version: Version = {
  ...calculation,
  id: versionID,
  sheet_id: sheetID,
  client_id: clientID,
  revision: '1',
  title: profile.title,
  note: profile.note,
  effective_from: profile.effective_from,
  effective_until: null,
  window_until: null,
  created_by: actorID,
  created_at: date,
}
export const sheet: Sheet = {
  id: sheetID,
  client_id: clientID,
  revision: '1',
  latest_version: version,
}
export function withoutCosts<T extends Calculation>(v: T): T {
  const r = structuredClone(v)
  delete (r as Calculation).cost_minor
  r.lines.forEach((l) => {
    delete (l as Calculation['lines'][number]).cost_minor
    delete l.unit_cost_minor
  })
  return r
}
export const snapshot: Snapshot = {
  ...withoutCosts(calculation),
  collection_id: '33333333-3333-4333-8333-333333333333',
  client_id: clientID,
  sheet_id: sheetID,
  version_id: versionID,
  pricing_revision: '1',
  command_id: nextID,
  billing_date: '2020-02-29',
  title: profile.title,
  created_by: actorID,
  created_at: date,
}
export const session = {
  ...identity,
  user: {
    ...identity.user,
    permissions: [
      'pricing.view',
      'pricing.manage',
      'billing.view',
      'billing.create',
      'billing.update',
    ].map((permission) => ({
      permission,
      scope: 'client' as const,
      client_id: clientID,
    })),
  },
}
