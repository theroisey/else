import { useEffect } from 'react'
import { warmWorkspace } from '../../app/prefetch'
import { PaymentRecoveryBoundary } from '../billing/PaymentRecovery'
import { CopyRecoveryBoundary } from '../pricing/CopyRecovery'
import { ApplicationShell } from './ApplicationShell'

// The authenticated layout stays mounted across routes, including uncertain writes.
export function WorkspaceArea() {
  useEffect(() => warmWorkspace(), [])
  return (
    <PaymentRecoveryBoundary>
      <CopyRecoveryBoundary>
        <ApplicationShell />
      </CopyRecoveryBoundary>
    </PaymentRecoveryBoundary>
  )
}
