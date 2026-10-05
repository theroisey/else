import { useAppearance } from '../features/appearance/theme'
import { Link, Navigate, Outlet, Route, Routes } from 'react-router'
import { lazy } from 'react'
import { buttonStyles } from '../components/ui'
import { FoundationPage } from '../features/foundation/FoundationPage'
import { InterfaceReviewPage } from '../features/interface-review/InterfaceReviewPage'
import { AuthProvider } from '../features/auth/AuthProvider'
import { AuthGuard, PermissionGuard } from '../features/auth/AuthGuard'
import { UsersPage } from '../features/administration/UsersPage'
import { RolesPage } from '../features/administration/RolesPage'
import { LoginPage } from '../features/auth/LoginPage'
import { ApplicationShell } from '../features/shell/ApplicationShell'
import { WorkspacePage } from '../features/shell/WorkspacePage'
import { AccessPage } from '../features/shell/AccessPage'
import { ClientRoute } from '../features/clients/ClientRoute'
import { PaymentRecoveryBoundary } from '../features/billing/PaymentRecovery'
import { CopyRecoveryBoundary } from '../features/pricing/CopyRecovery'

const ClientsPage = lazy(() => import('../features/clients/ClientsPage').then(m => ({ default: m.ClientsPage })))
const ClientEditorPage = lazy(() => import('../features/clients/ClientEditorPage').then(m => ({ default: m.ClientEditorPage })))
const OverviewPage = lazy(() => import('../features/overview/OverviewPage').then(m => ({ default: m.OverviewPage })))
const ClientProfilePage = lazy(() => import('../features/clients/ClientProfilePage').then(m => ({ default: m.ClientProfilePage })))
const TaskListPage = lazy(() => import('../features/tasks/TaskListPage').then(m => ({ default: m.TaskListPage })))
const TaskDetailPage = lazy(() => import('../features/tasks/TaskDetailPage').then(m => ({ default: m.TaskDetailPage })))
const TaskEditorPage = lazy(() => import('../features/tasks/TaskEditorPage').then(m => ({ default: m.TaskEditorPage })))
const PlanningListPage = lazy(() => import('../features/planning/PlanningListPage').then(m => ({ default: m.PlanningListPage })))
const PlanningDetailPage = lazy(() => import('../features/planning/PlanningDetailPage').then(m => ({ default: m.PlanningDetailPage })))
const PlanningEditorPage = lazy(() => import('../features/planning/PlanningEditorPage').then(m => ({ default: m.PlanningEditorPage })))

const ReminderListPage = lazy(() => import('../features/reminders/ReminderListPage').then(m => ({ default: m.ReminderListPage })))
const ReminderDetailPage = lazy(() => import('../features/reminders/ReminderDetailPage').then(m => ({ default: m.ReminderDetailPage })))
const ReminderEditorPage = lazy(() => import('../features/reminders/ReminderEditorPage').then(m => ({ default: m.ReminderEditorPage })))
const ActivityPage = lazy(() => import('../features/activity/ActivityPage').then(m => ({ default: m.ActivityPage })))
const IntegrationListPage = lazy(() => import('../features/integrations/IntegrationListPage').then(m => ({ default: m.IntegrationListPage })))
const IntegrationDetailPage = lazy(() => import('../features/integrations/IntegrationDetailPage').then(m => ({ default: m.IntegrationDetailPage })))
const AnalyticsListPage = lazy(() => import('../features/analytics/AnalyticsListPage').then(m => ({ default: m.AnalyticsListPage })))
const AnalyticsReportPage = lazy(() => import('../features/analytics/AnalyticsReportPage').then(m => ({ default: m.AnalyticsReportPage })))
const CommerceListPage = lazy(() => import('../features/ecommerce/CommerceListPage').then(m => ({ default: m.CommerceListPage })))
const CommerceReportPage = lazy(() => import('../features/ecommerce/CommerceReportPage').then(m => ({ default: m.CommerceReportPage })))
const MarketingListPage = lazy(() => import('../features/marketing/MarketingListPage').then(m => ({ default: m.MarketingListPage })))
const MarketingReportPage = lazy(() => import('../features/marketing/MarketingReportPage').then(m => ({ default: m.MarketingReportPage })))
const AuditPage = lazy(() => import('../features/audit/AuditPage').then(m => ({ default: m.AuditPage })))
const ReleasePage = lazy(() => import('../features/releases/ReleasePage').then(m => ({ default: m.ReleasePage })))
const BillingListPage = lazy(() => import('../features/billing/BillingListPage').then(m => ({ default: m.BillingListPage })))
const BillingDetailPage = lazy(() => import('../features/billing/BillingDetailPage').then(m => ({ default: m.BillingDetailPage })))
const BillingEditorPage = lazy(() => import('../features/billing/BillingEditorPage').then(m => ({ default: m.BillingEditorPage })))
const PricingListPage = lazy(() => import('../features/pricing/PricingListPage').then(m => ({ default: m.PricingListPage })))
const PricingDetailPage = lazy(() => import('../features/pricing/PricingDetailPage').then(m => ({ default: m.PricingDetailPage })))
const PricingEditorPage = lazy(() => import('../features/pricing/PricingEditorPage').then(m => ({ default: m.PricingEditorPage })))

function AuthArea() {
  return <AuthProvider><PaymentRecoveryBoundary><CopyRecoveryBoundary><Outlet /></CopyRecoveryBoundary></PaymentRecoveryBoundary></AuthProvider>
}

export function App() {
  useAppearance()
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/service-status" element={<FoundationPage />} />
      <Route path="/interface" element={<InterfaceReviewPage />} />
      <Route element={<AuthArea />}>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AuthGuard />}>
          <Route path="/app" element={<ApplicationShell />}>
            <Route index element={<WorkspacePage />} />
            <Route path="access" element={<AccessPage />} />
            <Route path="releases" element={<ClientRoute name="Release Center"><ReleasePage /></ClientRoute>} />
            <Route path="audit" element={<ClientRoute name="Audit"><AuditPage /></ClientRoute>} />
            <Route path="clients" element={<ClientRoute><ClientsPage /></ClientRoute>} />
            <Route path="clients/new" element={<ClientRoute><ClientEditorPage create /></ClientRoute>} />
            <Route path="clients/:id" element={<ClientRoute name="Overview"><OverviewPage /></ClientRoute>} />
            <Route path="clients/:id/profile" element={<ClientRoute><ClientProfilePage /></ClientRoute>} />
            <Route path="clients/:id/edit" element={<ClientRoute><ClientEditorPage /></ClientRoute>} />
            <Route path="clients/:id/activity" element={<ClientRoute name="Activity"><ActivityPage /></ClientRoute>} />
            <Route path="clients/:id/integrations" element={<ClientRoute name="Integrations"><IntegrationListPage /></ClientRoute>} />
            <Route path="clients/:id/integrations/:connectionID" element={<ClientRoute name="Integration"><IntegrationDetailPage /></ClientRoute>} />
            <Route path="clients/:id/analytics" element={<ClientRoute name="Web analytics"><AnalyticsListPage /></ClientRoute>} />
            <Route path="clients/:id/analytics/:connectionID" element={<ClientRoute name="Web analytics"><AnalyticsReportPage /></ClientRoute>} />
            <Route path="clients/:id/commerce" element={<ClientRoute name="Commerce"><CommerceListPage /></ClientRoute>} />
            <Route path="clients/:id/commerce/:connectionID" element={<ClientRoute name="Commerce"><CommerceReportPage /></ClientRoute>} />
            <Route path="clients/:id/marketing" element={<ClientRoute name="Marketing"><MarketingListPage /></ClientRoute>} />
            <Route path="clients/:id/marketing/:connectionID" element={<ClientRoute name="Marketing"><MarketingReportPage /></ClientRoute>} />
            <Route path="clients/:id/audit" element={<ClientRoute name="Audit"><AuditPage client /></ClientRoute>} />
            <Route path="clients/:id/billing" element={<ClientRoute name="Finance"><BillingListPage /></ClientRoute>} />
            <Route path="clients/:id/billing/new" element={<ClientRoute name="Finance"><BillingEditorPage create /></ClientRoute>} />
            <Route path="clients/:id/billing/:collectionID" element={<ClientRoute name="Finance"><BillingDetailPage /></ClientRoute>} />
            <Route path="clients/:id/billing/:collectionID/edit" element={<ClientRoute name="Finance"><BillingEditorPage /></ClientRoute>} />
            <Route path="clients/:id/pricing" element={<ClientRoute name="Pricing"><PricingListPage /></ClientRoute>} />
            <Route path="clients/:id/pricing/new" element={<ClientRoute name="Pricing"><PricingEditorPage create /></ClientRoute>} />
            <Route path="clients/:id/pricing/:sheetID" element={<ClientRoute name="Pricing"><PricingDetailPage /></ClientRoute>} />
            <Route path="clients/:id/pricing/:sheetID/new-version" element={<ClientRoute name="Pricing"><PricingEditorPage /></ClientRoute>} />
            <Route path="clients/:id/pricing/:sheetID/versions/:versionID" element={<ClientRoute name="Pricing"><PricingDetailPage /></ClientRoute>} />
            <Route path="clients/:id/tasks" element={<ClientRoute name="Task"><TaskListPage /></ClientRoute>} />
            <Route path="clients/:id/tasks/new" element={<ClientRoute name="Task"><TaskEditorPage create /></ClientRoute>} />
            <Route path="clients/:id/tasks/:taskID" element={<ClientRoute name="Task"><TaskDetailPage /></ClientRoute>} />
            <Route path="clients/:id/tasks/:taskID/edit" element={<ClientRoute name="Task"><TaskEditorPage /></ClientRoute>} />
            <Route path="clients/:id/plans" element={<ClientRoute name="Planning"><PlanningListPage /></ClientRoute>} />
            <Route path="clients/:id/plans/new" element={<ClientRoute name="Planning"><PlanningEditorPage create /></ClientRoute>} />
            <Route path="clients/:id/plans/:planID" element={<ClientRoute name="Planning"><PlanningDetailPage /></ClientRoute>} />
            <Route path="clients/:id/plans/:planID/edit" element={<ClientRoute name="Planning"><PlanningEditorPage /></ClientRoute>} />
            <Route path="clients/:id/plans/:planID/milestones" element={<ClientRoute name="Milestone"><PlanningListPage milestone /></ClientRoute>} />
            <Route path="clients/:id/plans/:planID/milestones/new" element={<ClientRoute name="Milestone"><PlanningEditorPage milestone create /></ClientRoute>} />
            <Route path="clients/:id/plans/:planID/milestones/:milestoneID" element={<ClientRoute name="Milestone"><PlanningDetailPage milestone /></ClientRoute>} />
            <Route path="clients/:id/plans/:planID/milestones/:milestoneID/edit" element={<ClientRoute name="Milestone"><PlanningEditorPage milestone /></ClientRoute>} />
            <Route path="clients/:id/reminders" element={<ClientRoute name="Reminder"><ReminderListPage /></ClientRoute>} />
            <Route path="clients/:id/reminders/new" element={<ClientRoute name="Reminder"><ReminderEditorPage create /></ClientRoute>} />
            <Route path="clients/:id/reminders/:reminderID" element={<ClientRoute name="Reminder"><ReminderDetailPage /></ClientRoute>} />
            <Route path="clients/:id/reminders/:reminderID/edit" element={<ClientRoute name="Reminder"><ReminderEditorPage /></ClientRoute>} />
            <Route path="users" element={
              <PermissionGuard required={{ permission: 'users.view', scope: 'global' }}>
                <UsersPage />
              </PermissionGuard>
            } />
            <Route path="roles" element={
              <PermissionGuard required={{ permission: 'roles.view', scope: 'global' }}>
                <RolesPage />
              </PermissionGuard>
            } />
            <Route path="*" element={<section><h1 className="page-title">Page not found</h1><p className="mt-3 text-muted">This destination is not available.</p><Link className={buttonStyles({ className: 'mt-6' })} to="/app">Open workspace</Link></section>} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={
        <main className="mx-auto max-w-3xl px-6 py-16">
          <p className="eyebrow">Roisey Else</p>
          <h1 className="page-title mt-4">Page not found</h1>
          <p className="mt-3 text-muted">This address has no available page.</p>
          <Link className={buttonStyles({ className: 'mt-6' })} to="/service-status">Open service status</Link>
        </main>
      } />
    </Routes>
  )
}
