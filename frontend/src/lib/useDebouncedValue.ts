import { useEffect, useState } from 'react'

/** Keep typing synchronous while coalescing cancellable, read-only searches. */
export function useDebouncedValue(value: string, delay = 200) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return settled
}
