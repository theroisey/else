import { BrandMark } from './Brand'

/** Match the pre-React loader without requests, boxed artwork or layout jumps. */
export function AppLoading({ label }: { label: string }) {
  return (
    <main className="boot-loading" role="status" aria-busy="true">
      <BrandMark className="loading-mark" />
      <span className="sr-only">{label}</span>
      <div className="boot-progress" aria-hidden="true" />
    </main>
  )
}
