import type { ReactNode } from 'react'
export function PageHeader({ eyebrow, title, description, children }: { eyebrow: ReactNode; title: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return <header className="page-header"><div className="min-w-0"><p className="eyebrow">{eyebrow}</p><h1 className="page-title">{title}</h1>{description ? <p className="page-description">{description}</p> : null}</div>{children ? <div className="page-actions">{children}</div> : null}</header>
}
