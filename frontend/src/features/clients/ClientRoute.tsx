import { Component, Suspense } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { Button, PageSkeleton } from '../../components/ui'

class PageLoadBoundary extends Component<{ children: ReactNode; name: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <section>
        <h1 className="page-title">{this.props.name} page unavailable</h1>
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
export function ClientRoute({ children, name = 'Client' }: { children: ReactNode; name?: string }) {
  const { pathname } = useLocation()
  return (
    <PageLoadBoundary key={pathname} name={name}>
      <Suspense
        fallback={
          <PageSkeleton label={`Loading ${name.toLowerCase()} page…`} />
        }
      >
        {children}
      </Suspense>
    </PageLoadBoundary>
  )
}
