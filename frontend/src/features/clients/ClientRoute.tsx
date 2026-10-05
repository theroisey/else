import { copy, useLocale } from '../../i18n/index'
import { Component, Suspense } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { Button, PageSkeleton } from '../../components/ui'

class PageLoadBoundary extends Component<
  { children: ReactNode; name: string },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <section>
        <h1 className="page-title">
          {copy('{{value1}} page unavailable', 'clients', {
            value1: this.props.name,
          })}
        </h1>
        <p className="mt-3 text-muted" role="alert">
          {copy('Reload the page to try again.', 'clients')}
        </p>
        <Button className="mt-4" onClick={() => window.location.reload()}>
          {copy('Reload page', 'clients')}
        </Button>
      </section>
    ) : (
      this.props.children
    )
  }
}
export function ClientRoute({
  children,
  name = copy('Client', 'clients'),
}: {
  children: ReactNode
  name?: string
}) {
  useLocale()
  const { pathname } = useLocation()
  return (
    <PageLoadBoundary key={pathname} name={name}>
      <Suspense
        fallback={
          <PageSkeleton
            label={copy('Loading {{value1}} page…', 'clients', {
              value1: name.toLowerCase(),
            })}
          />
        }
      >
        {children}
      </Suspense>
    </PageLoadBoundary>
  )
}
