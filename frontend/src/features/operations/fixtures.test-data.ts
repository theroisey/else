// Synthetic, empty operational snapshot for UI transport tests only.
export const emptyToday = {
  as_of: '2026-10-11T12:00:00.000000Z',
  horizon_end: '2026-10-18T12:00:00.000000Z',
  timezone: 'Europe/Bucharest',
  request_counts: {
    new: '0',
    accepted: '0',
    rejected: '0',
    in_progress: '0',
    delivered: '0',
    revision_requested: '0',
    approved: '0',
    cancelled: '0',
  },
  overdue_tasks: '0',
  requests: { items: [], has_more: false },
  tasks: { items: [], has_more: false },
  reminders: { items: [], has_more: false },
  brands: { items: [], has_more: false },
}
