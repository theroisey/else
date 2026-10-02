import { createContext, useContext } from 'react'
import type { PaymentInput } from './models'
export interface Command {
  client: string
  id: string
  revision: string
  payment: PaymentInput
}
export const RecoveryContext = createContext<{
  submit: (command: Command) => void
  busy: boolean
} | null>(null)
export function usePaymentRecovery() {
  const context = useContext(RecoveryContext)
  if (!context) throw new Error('Payment recovery is unavailable.')
  return context
}
