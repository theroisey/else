// Public code only. No record or permission data is prefetched.
export const routeLoaders = {
  FinancialDashboard: () =>
    import('../features/finance/FinancialDashboard').then((m) => ({
      default: m.FinancialDashboard,
    })),
  MCPPage: () =>
    import('../features/mcp/MCPPage').then((m) => ({ default: m.MCPPage })),
  RecurringPage: () =>
    import('../features/operations/RecurringPage').then((m) => ({
      default: m.RecurringPage,
    })),
  SettingsPage: () =>
    import('../features/operations/SettingsPage').then((m) => ({
      default: m.SettingsPage,
    })),
  FinancePage: () =>
    import('../features/operations/FinancePage').then((m) => ({
      default: m.FinancePage,
    })),
  TeamPage: () =>
    import('../features/operations/TeamPage').then((m) => ({
      default: m.TeamPage,
    })),
  WebsitesPage: () =>
    import('../features/websites/WebsitesPage').then((m) => ({
      default: m.WebsitesPage,
    })),
  WebsitePage: () =>
    import('../features/websites/WebsitePage').then((m) => ({
      default: m.WebsitePage,
    })),
  ClientsPage: () =>
    import('../features/clients/ClientsPage').then((m) => ({
      default: m.ClientsPage,
    })),
  ClientEditorPage: () =>
    import('../features/clients/ClientEditorPage').then((m) => ({
      default: m.ClientEditorPage,
    })),
  OverviewPage: () =>
    import('../features/overview/OverviewPage').then((m) => ({
      default: m.OverviewPage,
    })),
  ClientProfilePage: () =>
    import('../features/clients/ClientProfilePage').then((m) => ({
      default: m.ClientProfilePage,
    })),
  TaskListPage: () =>
    import('../features/tasks/TaskListPage').then((m) => ({
      default: m.TaskListPage,
    })),
  TaskDetailPage: () =>
    import('../features/tasks/TaskDetailPage').then((m) => ({
      default: m.TaskDetailPage,
    })),
  TaskEditorPage: () =>
    import('../features/tasks/TaskEditorPage').then((m) => ({
      default: m.TaskEditorPage,
    })),
  PlanningListPage: () =>
    import('../features/planning/PlanningListPage').then((m) => ({
      default: m.PlanningListPage,
    })),
  PlanningDetailPage: () =>
    import('../features/planning/PlanningDetailPage').then((m) => ({
      default: m.PlanningDetailPage,
    })),
  PlanningEditorPage: () =>
    import('../features/planning/PlanningEditorPage').then((m) => ({
      default: m.PlanningEditorPage,
    })),
  ReminderListPage: () =>
    import('../features/reminders/ReminderListPage').then((m) => ({
      default: m.ReminderListPage,
    })),
  ReminderDetailPage: () =>
    import('../features/reminders/ReminderDetailPage').then((m) => ({
      default: m.ReminderDetailPage,
    })),
  ReminderEditorPage: () =>
    import('../features/reminders/ReminderEditorPage').then((m) => ({
      default: m.ReminderEditorPage,
    })),
  ActivityPage: () =>
    import('../features/activity/ActivityPage').then((m) => ({
      default: m.ActivityPage,
    })),
  IntegrationListPage: () =>
    import('../features/integrations/IntegrationListPage').then((m) => ({
      default: m.IntegrationListPage,
    })),
  IntegrationDetailPage: () =>
    import('../features/integrations/IntegrationDetailPage').then((m) => ({
      default: m.IntegrationDetailPage,
    })),
  AnalyticsListPage: () =>
    import('../features/analytics/AnalyticsListPage').then((m) => ({
      default: m.AnalyticsListPage,
    })),
  AnalyticsReportPage: () =>
    import('../features/analytics/AnalyticsReportPage').then((m) => ({
      default: m.AnalyticsReportPage,
    })),
  CommerceListPage: () =>
    import('../features/ecommerce/CommerceListPage').then((m) => ({
      default: m.CommerceListPage,
    })),
  CommerceReportPage: () =>
    import('../features/ecommerce/CommerceReportPage').then((m) => ({
      default: m.CommerceReportPage,
    })),
  MarketingListPage: () =>
    import('../features/marketing/MarketingListPage').then((m) => ({
      default: m.MarketingListPage,
    })),
  MarketingReportPage: () =>
    import('../features/marketing/MarketingReportPage').then((m) => ({
      default: m.MarketingReportPage,
    })),
  AuditPage: () =>
    import('../features/audit/AuditPage').then((m) => ({
      default: m.AuditPage,
    })),
  BillingListPage: () =>
    import('../features/billing/BillingListPage').then((m) => ({
      default: m.BillingListPage,
    })),
  BillingDetailPage: () =>
    import('../features/billing/BillingDetailPage').then((m) => ({
      default: m.BillingDetailPage,
    })),
  BillingEditorPage: () =>
    import('../features/billing/BillingEditorPage').then((m) => ({
      default: m.BillingEditorPage,
    })),
  PricingListPage: () =>
    import('../features/pricing/PricingListPage').then((m) => ({
      default: m.PricingListPage,
    })),
  PricingDetailPage: () =>
    import('../features/pricing/PricingDetailPage').then((m) => ({
      default: m.PricingDetailPage,
    })),
  PricingEditorPage: () =>
    import('../features/pricing/PricingEditorPage').then((m) => ({
      default: m.PricingEditorPage,
    })),
  TaskQueuePage: () =>
    import('../features/operations/TaskQueuePage').then((m) => ({
      default: m.TaskQueuePage,
    })),
  TodayPage: () =>
    import('../features/operations/TodayPage').then((m) => ({
      default: m.TodayPage,
    })),
  RequestListPage: () =>
    import('../features/operations/RequestListPage').then((m) => ({
      default: m.RequestListPage,
    })),
  RequestCreatePage: () =>
    import('../features/operations/RequestCreatePage').then((m) => ({
      default: m.RequestCreatePage,
    })),
  RequestDetailPage: () =>
    import('../features/operations/RequestDetailPage').then((m) => ({
      default: m.RequestDetailPage,
    })),
  NotificationsPage: () =>
    import('../features/operations/Notifications').then((m) => ({
      default: m.NotificationsPage,
    })),
  UsersPage: () =>
    import('../features/administration/UsersPage').then((m) => ({
      default: m.UsersPage,
    })),
  RolesPage: () =>
    import('../features/administration/RolesPage').then((m) => ({
      default: m.RolesPage,
    })),
  InterfaceReviewPage: () =>
    import('../features/interface-review/InterfaceReviewPage').then((m) => ({
      default: m.InterfaceReviewPage,
    })),
  WorkspacePage: () =>
    import('../features/shell/WorkspacePage').then((m) => ({
      default: m.WorkspacePage,
    })),
  WorkspaceArea: () =>
    import('../features/shell/WorkspaceArea').then((m) => ({
      default: m.WorkspaceArea,
    })),
}
