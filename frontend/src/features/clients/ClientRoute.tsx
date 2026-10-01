import { Component, Suspense } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { Button } from '../../components/ui'

class PageLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <section>
        <h1 className="text-2xl font-semibold">Client page unavailable</h1>
        <p className="mt-3 text-muted" role="alert">
          Reload the page to try again.
        </p>
        <Button className="mt-4" onClick={() => window.location.reload()}>
          Reload page
        </Button>
      </section>
    ) : (
      this.props.children
    )
  }
}
export function ClientRoute({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <PageLoadBoundary key={pathname}>
      <Suspense
        fallback={
          <p role="status" aria-busy="true">
            Loading client page…
          </p>
        }
      >
        {children}
      </Suspense>
    </PageLoadBoundary>
  )
}
