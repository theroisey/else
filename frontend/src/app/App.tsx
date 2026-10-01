import { Link, Route, Routes } from 'react-router'
import { buttonStyles } from '../components/ui'
import { FoundationPage } from '../features/foundation/FoundationPage'
import { InterfaceReviewPage } from '../features/interface-review/InterfaceReviewPage'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<FoundationPage />} />
      <Route path="/interface" element={<InterfaceReviewPage />} />
      <Route path="*" element={
        <main className="mx-auto max-w-3xl px-6 py-16">
          <p className="eyebrow">Roisey Else</p>
          <h1 className="mt-4 text-2xl font-semibold">Page not found</h1>
          <p className="mt-3 text-muted">This address has no available page.</p>
          <Link className={buttonStyles({ className: 'mt-6' })} to="/">Open service status</Link>
        </main>
      } />
    </Routes>
  )
}
