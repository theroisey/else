import { createContext, useContext } from 'react'
export interface ExpenseCommand {
  summary: string
  path: string
  input: unknown
}
export const ExpenseRecoveryContext = createContext<{
  busy: boolean
  submit: (command: ExpenseCommand) => void
} | null>(null)
export function useExpenseRecovery() {
  const v = useContext(ExpenseRecoveryContext)
  if (!v) throw Error('Expense recovery unavailable')
  return v
}
