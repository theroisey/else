import { routeLoaders } from './route-loaders'
import { loadModule } from './lazy-page'

type RouteName = keyof typeof routeLoaders
const warmed = new Set<RouteName>()
function economicalConnection() {
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string }
    }
  ).connection
  return (
    connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')
  )
}
function warm(name: RouteName) {
  if (economicalConnection() || warmed.has(name)) return
  warmed.add(name)
  void loadModule<unknown>(routeLoaders[name]).catch(() => warmed.delete(name))
}
export function warmWorkspace(path = '/app') {
  warmDestination(path)
  // A small, bounded working set avoids a network waterfall on the first click.
  for (const name of [
    'TodayPage',
    'ClientsPage',
    'SettingsPage',
    'TaskQueuePage',
    'RequestListPage',
  ] as const)
    warm(name)
}
export function warmDestination(path: string) {
  warm('WorkspaceArea')
  const requested = destination(path)
  if (requested) warm(requested)
}

// Public modules only: hover never fetches authenticated records.
function destination(path: string): RouteName | undefined {
  const global: Record<string, RouteName> = {
    '/app': 'TodayPage',
    '/app/clients': 'ClientsPage',
    '/app/clients/new': 'ClientEditorPage',
    '/app/portfolio': 'WorkspacePage',
    '/app/settings': 'SettingsPage',
    '/app/tasks': 'TaskQueuePage',
    '/app/requests': 'RequestListPage',
    '/app/requests/new': 'RequestCreatePage',
    '/app/notifications': 'NotificationsPage',
    '/app/finance': 'FinancePage',
    '/app/users': 'UsersPage',
    '/app/roles': 'RolesPage',
    '/app/audit': 'AuditPage',
  }
  if (Object.hasOwn(global, path)) return global[path]
  if (/^\/app\/team(?:\/[0-9a-f-]{36})?$/.test(path)) return 'TeamPage'
  const client = /^\/app\/clients\/[0-9a-f-]{36}(?:\/(.*))?$/.exec(path)
  if (!client) return undefined
  const section = client[1] ?? ''
  if (!section) return 'OverviewPage'
  if (section === 'edit') return 'ClientEditorPage'
  if (section === 'profile') return 'ClientProfilePage'
  if (section === 'activity') return 'ActivityPage'
  if (section === 'audit') return 'AuditPage'
  if (/^finance(?:\/|$)/.test(section)) return 'FinancePage'
  if (/^recurring-tasks(?:\/|$)/.test(section)) return 'RecurringPage'
  if (/^websites(?:\/|$)/.test(section)) {
    if (section.endsWith('/requests/new')) return 'RequestCreatePage'
    const report =
      /\/(analytics|commerce|marketing|integrations)\/[0-9a-f-]{36}$/.exec(
        section,
      )?.[1]
    const reports: Record<string, RouteName> = {
      analytics: 'AnalyticsReportPage',
      commerce: 'CommerceReportPage',
      marketing: 'MarketingReportPage',
      integrations: 'IntegrationDetailPage',
    }
    if (report) return reports[report]
    return section === 'websites' ? 'WebsitesPage' : 'WebsitePage'
  }
  for (const [prefix, list, detail, editor] of [
    ['requests', 'RequestListPage', 'RequestDetailPage', 'RequestCreatePage'],
    ['tasks', 'TaskListPage', 'TaskDetailPage', 'TaskEditorPage'],
    ['plans', 'PlanningListPage', 'PlanningDetailPage', 'PlanningEditorPage'],
    [
      'reminders',
      'ReminderListPage',
      'ReminderDetailPage',
      'ReminderEditorPage',
    ],
    ['billing', 'BillingListPage', 'BillingDetailPage', 'BillingEditorPage'],
    ['pricing', 'PricingListPage', 'PricingDetailPage', 'PricingEditorPage'],
    [
      'analytics',
      'AnalyticsListPage',
      'AnalyticsReportPage',
      'AnalyticsReportPage',
    ],
    [
      'commerce',
      'CommerceListPage',
      'CommerceReportPage',
      'CommerceReportPage',
    ],
    [
      'marketing',
      'MarketingListPage',
      'MarketingReportPage',
      'MarketingReportPage',
    ],
    [
      'integrations',
      'IntegrationListPage',
      'IntegrationDetailPage',
      'IntegrationDetailPage',
    ],
  ] as const) {
    if (
      section === prefix ||
      (prefix === 'plans' && section.endsWith('/milestones'))
    )
      return list
    if (!section.startsWith(prefix + '/')) continue
    return /\/(new|edit|new-version)$/.test(section) ? editor : detail
  }
  return undefined
}
export function preloadLink(event: { target: EventTarget | null }) {
  const link =
    event.target instanceof Element ? event.target.closest('a[href]') : null
  if (
    !(link instanceof HTMLAnchorElement) ||
    link.target ||
    link.hasAttribute('download')
  )
    return
  const url = new URL(link.href)
  if (url.origin !== window.location.origin) return
  const name = destination(url.pathname)
  if (name) warm(name)
}
