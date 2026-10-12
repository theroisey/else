import { useState } from 'react'
import { Button } from '../../components/ui'
import { copy } from '../../i18n'
export function MaskedReference({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false)
  return value ? (
    <div className="mt-2 break-words text-sm text-muted">
      <span>{revealed ? value : copy('Reference hidden', 'billing')}</span>
      <Button
        variant="text"
        size="compact"
        className="ml-3"
        onClick={() => setRevealed(!revealed)}
      >
        {copy(revealed ? 'Hide reference' : 'Reveal reference', 'billing')}
      </Button>
    </div>
  ) : null
}
