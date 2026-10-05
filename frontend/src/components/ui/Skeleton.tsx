export function PageSkeleton({ label = 'Loading workspace…' }: { label?: string }) {
  return <div className="page-skeleton" role="status" aria-busy="true"><span className="sr-only">{label}</span><div className="skeleton skeleton-heading" /><div className="skeleton skeleton-context" /><div className="skeleton-rule" /><div className="skeleton-workspace">{[0, 1, 2, 3].map(row => <div className="skeleton skeleton-row" key={row} />)}</div></div>
}
