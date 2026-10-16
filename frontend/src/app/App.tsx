import { copy, useLocale } from '../i18n/index'
import { AppearanceSync } from '../features/appearance/Appearance'
import { Link, Navigate, Outlet, Route, Routes } from 'react-router'
import { lazyPage } from './lazy-page'
import { useEffect } from 'react'
import { useLocation } from 'react-router'
import { warmDestination } from './prefetch'
import { routeLoaders } from './route-loaders'
import { buttonStyles } from '../components/ui'
import { AuthProvider } from '../features/auth/AuthProvider'
import { AuthGuard, PermissionGuard } from '../features/auth/AuthGuard'
import { LoginPage } from '../features/auth/LoginPage'
import { ClientRoute, WorkspaceRoute } from '../features/clients/ClientRoute'
import { NavigationFocus } from '../features/shell/NavigationFocus'

const RecurringPage = lazyPage(routeLoaders.RecurringPage)
const SettingsPage = lazyPage(routeLoaders.SettingsPage)
const FinancePage = lazyPage(routeLoaders.FinancePage)
const TeamPage = lazyPage(routeLoaders.TeamPage)
const WebsitesPage = lazyPage(routeLoaders.WebsitesPage)
const WebsitePage = lazyPage(routeLoaders.WebsitePage)
const ClientsPage = lazyPage(routeLoaders.ClientsPage)
const ClientEditorPage = lazyPage(routeLoaders.ClientEditorPage)
const OverviewPage = lazyPage(routeLoaders.OverviewPage)
const ClientProfilePage = lazyPage(routeLoaders.ClientProfilePage)
const TaskListPage = lazyPage(routeLoaders.TaskListPage)
const TaskDetailPage = lazyPage(routeLoaders.TaskDetailPage)
const TaskEditorPage = lazyPage(routeLoaders.TaskEditorPage)
const PlanningListPage = lazyPage(routeLoaders.PlanningListPage)
const PlanningDetailPage = lazyPage(routeLoaders.PlanningDetailPage)
const PlanningEditorPage = lazyPage(routeLoaders.PlanningEditorPage)

const ReminderListPage = lazyPage(routeLoaders.ReminderListPage)
const ReminderDetailPage = lazyPage(routeLoaders.ReminderDetailPage)
const ReminderEditorPage = lazyPage(routeLoaders.ReminderEditorPage)
const ActivityPage = lazyPage(routeLoaders.ActivityPage)
const IntegrationListPage = lazyPage(routeLoaders.IntegrationListPage)
const IntegrationDetailPage = lazyPage(routeLoaders.IntegrationDetailPage)
const AnalyticsListPage = lazyPage(routeLoaders.AnalyticsListPage)
const AnalyticsReportPage = lazyPage(routeLoaders.AnalyticsReportPage)
const CommerceListPage = lazyPage(routeLoaders.CommerceListPage)
const CommerceReportPage = lazyPage(routeLoaders.CommerceReportPage)
const MarketingListPage = lazyPage(routeLoaders.MarketingListPage)
const MarketingReportPage = lazyPage(routeLoaders.MarketingReportPage)
const AuditPage = lazyPage(routeLoaders.AuditPage)
const BillingListPage = lazyPage(routeLoaders.BillingListPage)
const BillingDetailPage = lazyPage(routeLoaders.BillingDetailPage)
const BillingEditorPage = lazyPage(routeLoaders.BillingEditorPage)
const PricingListPage = lazyPage(routeLoaders.PricingListPage)
const PricingDetailPage = lazyPage(routeLoaders.PricingDetailPage)
const PricingEditorPage = lazyPage(routeLoaders.PricingEditorPage)

const TaskQueuePage = lazyPage(routeLoaders.TaskQueuePage)
const TodayPage = lazyPage(routeLoaders.TodayPage)
const RequestListPage = lazyPage(routeLoaders.RequestListPage)
const RequestCreatePage = lazyPage(routeLoaders.RequestCreatePage)
const RequestDetailPage = lazyPage(routeLoaders.RequestDetailPage)
const NotificationsPage = lazyPage(routeLoaders.NotificationsPage)

const UsersPage = lazyPage(routeLoaders.UsersPage)

const RolesPage = lazyPage(routeLoaders.RolesPage)

const InterfaceReviewPage = lazyPage(routeLoaders.InterfaceReviewPage)

const WorkspacePage = lazyPage(routeLoaders.WorkspacePage)

const WorkspaceArea = lazyPage(routeLoaders.WorkspaceArea)

function AuthArea() {
  useLocale()
  const { pathname } = useLocation()
  useEffect(() => {
    if (pathname === '/app' || pathname.startsWith('/app/')) warmDestination(pathname)
  }, [pathname])
  return (
    <AuthProvider>
      <NavigationFocus>
        <Outlet />
      </NavigationFocus>
    </AuthProvider>
  )
}

export function App() {
  useLocale()
  return (
    <>
      <AppearanceSync />
      <ApplicationRoutes />
    </>
  )
}

function ApplicationRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route
        path="/interface"
        element={
          <ClientRoute>
            <InterfaceReviewPage />
          </ClientRoute>
        }
      />
      <Route element={<AuthArea />}>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AuthGuard />}>
          <Route
            path="/app"
            element={
              <WorkspaceRoute>
                <WorkspaceArea />
              </WorkspaceRoute>
            }
          >
            <Route
              index
              element={
                <ClientRoute>
                  <TodayPage />
                </ClientRoute>
              }
            />
            <Route
              path="tasks"
              element={
                <ClientRoute>
                  <TaskQueuePage />
                </ClientRoute>
              }
            />
            <Route
              path="portfolio"
              element={
                <ClientRoute>
                  <WorkspacePage />
                </ClientRoute>
              }
            />
            <Route
              path="team"
              element={
                <ClientRoute>
                  <TeamPage />
                </ClientRoute>
              }
            />
            <Route
              path="team/:teamID"
              element={
                <ClientRoute>
                  <TeamPage />
                </ClientRoute>
              }
            />
            <Route
              path="requests"
              element={
                <ClientRoute>
                  <RequestListPage />
                </ClientRoute>
              }
            />
            <Route
              path="requests/new"
              element={
                <ClientRoute>
                  <RequestCreatePage />
                </ClientRoute>
              }
            />
            <Route
              path="notifications"
              element={
                <ClientRoute>
                  <NotificationsPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/requests"
              element={
                <ClientRoute>
                  <RequestListPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/requests/new"
              element={
                <ClientRoute>
                  <RequestCreatePage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/requests/:requestID"
              element={
                <ClientRoute>
                  <RequestDetailPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/websites/:websiteID/requests/new"
              element={
                <ClientRoute>
                  <RequestCreatePage />
                </ClientRoute>
              }
            />
            <Route
              path="finance"
              element={
                <ClientRoute>
                  <FinancePage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/finance"
              element={
                <ClientRoute>
                  <FinancePage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/finance/:periodID"
              element={
                <ClientRoute>
                  <FinancePage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/recurring-tasks"
              element={
                <ClientRoute>
                  <RecurringPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/recurring-tasks/:templateID"
              element={
                <ClientRoute>
                  <RecurringPage />
                </ClientRoute>
              }
            />
            <Route
              path="settings"
              element={
                <ClientRoute>
                  <SettingsPage />
                </ClientRoute>
              }
            />
            <Route path="access" element={<Navigate to="/app" replace />} />
            <Route
              path="audit"
              element={
                <ClientRoute name={copy('Audit', 'common')}>
                  <AuditPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients"
              element={
                <ClientRoute>
                  <ClientsPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/new"
              element={
                <ClientRoute>
                  <ClientEditorPage create />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id"
              element={
                <ClientRoute name={copy('Overview', 'common')}>
                  <OverviewPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/profile"
              element={
                <ClientRoute>
                  <ClientProfilePage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/edit"
              element={
                <ClientRoute>
                  <ClientEditorPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/websites"
              element={
                <ClientRoute name={copy('Websites', 'common')}>
                  <WebsitesPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/websites/:websiteID"
              element={
                <ClientRoute name={copy('Website', 'common')}>
                  <WebsitePage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/websites/:websiteID/:websiteModule"
              element={
                <ClientRoute name={copy('Website', 'common')}>
                  <WebsitePage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/websites/:websiteID/analytics/:connectionID"
              element={
                <ClientRoute name={copy('Web analytics', 'common')}>
                  <AnalyticsReportPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/websites/:websiteID/commerce/:connectionID"
              element={
                <ClientRoute name={copy('Commerce', 'common')}>
                  <CommerceReportPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/websites/:websiteID/marketing/:connectionID"
              element={
                <ClientRoute name={copy('Marketing', 'common')}>
                  <MarketingReportPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/websites/:websiteID/integrations/:connectionID"
              element={
                <ClientRoute name={copy('Integration', 'common')}>
                  <IntegrationDetailPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/activity"
              element={
                <ClientRoute name={copy('Activity', 'common')}>
                  <ActivityPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/integrations"
              element={
                <ClientRoute name={copy('Integrations', 'common')}>
                  <IntegrationListPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/integrations/:connectionID"
              element={
                <ClientRoute name={copy('Integration', 'common')}>
                  <IntegrationDetailPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/analytics"
              element={
                <ClientRoute name={copy('Web analytics', 'common')}>
                  <AnalyticsListPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/analytics/:connectionID"
              element={
                <ClientRoute name={copy('Web analytics', 'common')}>
                  <AnalyticsReportPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/commerce"
              element={
                <ClientRoute name={copy('Commerce', 'common')}>
                  <CommerceListPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/commerce/:connectionID"
              element={
                <ClientRoute name={copy('Commerce', 'common')}>
                  <CommerceReportPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/marketing"
              element={
                <ClientRoute name={copy('Marketing', 'common')}>
                  <MarketingListPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/marketing/:connectionID"
              element={
                <ClientRoute name={copy('Marketing', 'common')}>
                  <MarketingReportPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/audit"
              element={
                <ClientRoute name={copy('Audit', 'common')}>
                  <AuditPage client />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/billing"
              element={
                <ClientRoute name={copy('Finance', 'common')}>
                  <BillingListPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/billing/new"
              element={
                <ClientRoute name={copy('Finance', 'common')}>
                  <BillingEditorPage create />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/billing/:collectionID"
              element={
                <ClientRoute name={copy('Finance', 'common')}>
                  <BillingDetailPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/billing/:collectionID/edit"
              element={
                <ClientRoute name={copy('Finance', 'common')}>
                  <BillingEditorPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/pricing"
              element={
                <ClientRoute name={copy('Pricing', 'common')}>
                  <PricingListPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/pricing/new"
              element={
                <ClientRoute name={copy('Pricing', 'common')}>
                  <PricingEditorPage create />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/pricing/:sheetID"
              element={
                <ClientRoute name={copy('Pricing', 'common')}>
                  <PricingDetailPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/pricing/:sheetID/new-version"
              element={
                <ClientRoute name={copy('Pricing', 'common')}>
                  <PricingEditorPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/pricing/:sheetID/versions/:versionID"
              element={
                <ClientRoute name={copy('Pricing', 'common')}>
                  <PricingDetailPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/tasks"
              element={
                <ClientRoute name={copy('Task', 'common')}>
                  <TaskListPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/tasks/new"
              element={
                <ClientRoute name={copy('Task', 'common')}>
                  <TaskEditorPage create />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/tasks/:taskID"
              element={
                <ClientRoute name={copy('Task', 'common')}>
                  <TaskDetailPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/tasks/:taskID/edit"
              element={
                <ClientRoute name={copy('Task', 'common')}>
                  <TaskEditorPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/plans"
              element={
                <ClientRoute name={copy('Planning', 'common')}>
                  <PlanningListPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/plans/new"
              element={
                <ClientRoute name={copy('Planning', 'common')}>
                  <PlanningEditorPage create />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/plans/:planID"
              element={
                <ClientRoute name={copy('Planning', 'common')}>
                  <PlanningDetailPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/plans/:planID/edit"
              element={
                <ClientRoute name={copy('Planning', 'common')}>
                  <PlanningEditorPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/plans/:planID/milestones"
              element={
                <ClientRoute name={copy('Milestone', 'common')}>
                  <PlanningListPage milestone />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/plans/:planID/milestones/new"
              element={
                <ClientRoute name={copy('Milestone', 'common')}>
                  <PlanningEditorPage milestone create />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/plans/:planID/milestones/:milestoneID"
              element={
                <ClientRoute name={copy('Milestone', 'common')}>
                  <PlanningDetailPage milestone />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/plans/:planID/milestones/:milestoneID/edit"
              element={
                <ClientRoute name={copy('Milestone', 'common')}>
                  <PlanningEditorPage milestone />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/reminders"
              element={
                <ClientRoute name={copy('Reminder', 'common')}>
                  <ReminderListPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/reminders/new"
              element={
                <ClientRoute name={copy('Reminder', 'common')}>
                  <ReminderEditorPage create />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/reminders/:reminderID"
              element={
                <ClientRoute name={copy('Reminder', 'common')}>
                  <ReminderDetailPage />
                </ClientRoute>
              }
            />
            <Route
              path="clients/:id/reminders/:reminderID/edit"
              element={
                <ClientRoute name={copy('Reminder', 'common')}>
                  <ReminderEditorPage />
                </ClientRoute>
              }
            />
            <Route
              path="users"
              element={
                <PermissionGuard
                  required={{ permission: 'users.view', scope: 'global' }}
                >
                  <ClientRoute name={copy('Users', 'common')}>
                    <UsersPage />
                  </ClientRoute>
                </PermissionGuard>
              }
            />
            <Route
              path="roles"
              element={
                <PermissionGuard
                  required={{ permission: 'roles.view', scope: 'global' }}
                >
                  <ClientRoute name={copy('Roles', 'common')}>
                    <RolesPage />
                  </ClientRoute>
                </PermissionGuard>
              }
            />
            <Route
              path="*"
              element={
                <section>
                  <h1 className="page-title">
                    {copy('Page not found', 'common')}
                  </h1>
                  <p className="mt-3 text-muted">
                    {copy('This destination is not available.', 'common')}
                  </p>
                  <Link
                    className={buttonStyles({ className: 'mt-6' })}
                    to="/app"
                  >
                    {copy('Open workspace', 'common')}
                  </Link>
                </section>
              }
            />
          </Route>
        </Route>
      </Route>
      <Route
        path="*"
        element={
          <main className="mx-auto max-w-3xl px-6 py-16">
            <p className="eyebrow">Roisey Else</p>
            <h1 className="page-title mt-4">
              {copy('Page not found', 'common')}
            </h1>
            <p className="mt-3 text-muted">
              {copy('This address has no available page.', 'common')}
            </p>
            <Link className={buttonStyles({ className: 'mt-6' })} to="/app">
              {copy('Open workspace', 'common')}
            </Link>
          </main>
        }
      />
    </Routes>
  )
}
