import { Link, Navigate, Outlet, Route, Routes } from 'react-router'
import { buttonStyles } from '../components/ui'
import { FoundationPage } from '../features/foundation/FoundationPage'
import { InterfaceReviewPage } from '../features/interface-review/InterfaceReviewPage'
import { AuthProvider } from '../features/auth/AuthProvider'
import { AuthGuard } from '../features/auth/AuthGuard'
import { LoginPage } from '../features/auth/LoginPage'
import { ApplicationShell } from '../features/shell/ApplicationShell'
import { WorkspacePage } from '../features/shell/WorkspacePage'
import { AccessPage } from '../features/shell/AccessPage'

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
