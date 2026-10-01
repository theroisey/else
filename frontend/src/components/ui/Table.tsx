import type { ReactNode, TableHTMLAttributes } from 'react'

interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  caption: string
  children: ReactNode
}

export function Table({ caption, children, className = '', ...props }: TableProps) {
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-surface" role="region" aria-label={caption} tabIndex={0}>
      <table {...props} className={`ui-table ${className}`.trim()}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  )
}
