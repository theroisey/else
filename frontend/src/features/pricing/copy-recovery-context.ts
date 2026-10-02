import { createContext, useContext } from 'react'
import type { CopyInput } from './models'
import type { Currency } from '../billing/money'
export interface CopyCommand {
  client: string
  sheet: string
  version: string
  revision: string
  input: CopyInput
  currency: Currency
  total: string
}
export const CopyRecoveryContext = createContext<{
  busy: boolean
  submit: (command: CopyCommand) => void
} | null>(null)
export function useCopyRecovery() {
  const c = useContext(CopyRecoveryContext)
  if (!c) throw new Error('Collection recovery is unavailable.')
  return c
}
