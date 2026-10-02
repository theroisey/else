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

const ClientsPage = lazy(() => import('../features/clients/ClientsPage').then(m => ({ default: m.ClientsPage })))
const ClientEditorPage = lazy(() => import('../features/clients/ClientEditorPage').then(m => ({ default: m.ClientEditorPage })))
const ClientWorkspacePage = lazy(() => import('../features/clients/ClientWorkspacePage').then(m => ({ default: m.ClientWorkspacePage })))
const TaskListPage = lazy(() => import('../features/tasks/TaskListPage').then(m => ({ default: m.TaskListPage })))
const TaskDetailPage = lazy(() => import('../features/tasks/TaskDetailPage').then(m => ({ default: m.TaskDetailPage })))
const TaskEditorPage = lazy(() => import('../features/tasks/TaskEditorPage').then(m => ({ default: m.TaskEditorPage })))

function AuthArea() {
  return <AuthProvider><Outlet /></AuthProvider>
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/status" element={<FoundationPage />} />
      <Route path="/interface" element={<InterfaceReviewPage />} />
      <Route element={<AuthArea />}>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AuthGuard />}>
          <Route path="/app" element={<ApplicationShell />}>
            <Route index element={<WorkspacePage />} />
            <Route path="access" element={<AccessPage />} />
            <Route path="clients" element={<ClientRoute><ClientsPage /></ClientRoute>} />
            <Route path="clients/new" element={<ClientRoute><ClientEditorPage create /></ClientRoute>} />
            <Route path="clients/:id" element={<ClientRoute><ClientWorkspacePage /></ClientRoute>} />
            <Route path="clients/:id/edit" element={<ClientRoute><ClientEditorPage /></ClientRoute>} />
            <Route path="clients/:id/tasks" element={<ClientRoute name="Task"><TaskListPage /></ClientRoute>} />
            <Route path="clients/:id/tasks/new" element={<ClientRoute name="Task"><TaskEditorPage create /></ClientRoute>} />
            <Route path="clients/:id/tasks/:taskID" element={<ClientRoute name="Task"><TaskDetailPage /></ClientRoute>} />
            <Route path="clients/:id/tasks/:taskID/edit" element={<ClientRoute name="Task"><TaskEditorPage /></ClientRoute>} />
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
            <Route path="*" element={<section><h1 className="text-2xl font-semibold">Page not found</h1><p className="mt-3 text-muted">This destination is not available.</p><Link className={buttonStyles({ className: 'mt-6' })} to="/app">Open workspace</Link></section>} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={
        <main className="mx-auto max-w-3xl px-6 py-16">
          <p className="eyebrow">Roisey Else</p>
          <h1 className="mt-4 text-2xl font-semibold">Page not found</h1>
          <p className="mt-3 text-muted">This address has no available page.</p>
          <Link className={buttonStyles({ className: 'mt-6' })} to="/status">Open service status</Link>
        </main>
      } />
    </Routes>
  )
}
