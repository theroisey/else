import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Button, Dialog } from '../../components/ui'
import { useAuth } from '../auth/auth-context'
import { useRecordOperations } from '../auth/useRecordOperations'
import { copy, useLocale } from '../../i18n'
import { ExpenseRecoveryContext, type ExpenseCommand } from './recovery-context'
import { mutateExpense, type Expense } from './service'
const t = (s: string) => copy(s, 'finance')
export function ExpenseRecoveryBoundary({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const handlerRef = useRef<((c: ExpenseCommand) => void) | null>(null),
    [busy, setBusy] = useState(false)
  return (
    <ExpenseRecoveryContext
      value={{ busy, submit: (c) => handlerRef.current?.(c) }}
    >
      {children}
      <Controller
        key={
          auth.session?.user.id +
          JSON.stringify(auth.session?.user.permissions ?? [])
        }
        handlerRef={handlerRef}
        onBusy={setBusy}
      />
    </ExpenseRecoveryContext>
  )
}
function Controller({
  handlerRef,
  onBusy,
}: {
  handlerRef: RefObject<((c: ExpenseCommand) => void) | null>
  onBusy: (v: boolean) => void
}) {
  useLocale()
  const op = useRecordOperations('finance')
  const [command, setCommand] = useState<ExpenseCommand | null>(null),
    [result, setResult] = useState<Expense | null>(null),
    [reviewed, setReviewed] = useState(false),
    [sent, setSent] = useState(false)
  const active = useRef(false),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    handlerRef.current = (c) => {
      if (!active.current) {
        active.current = true
        setCommand(structuredClone(c))
        setResult(null)
        setReviewed(false)
        setSent(false)
      }
    }
    return () => {
      mounted.current = false
      handlerRef.current = null
      onBusy(false)
    }
  }, [handlerRef, onBusy])
  useEffect(() => {
    onBusy(command !== null)
  }, [command, onBusy])
  useEffect(() => {
    if (!command || result) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [command, result])
  async function send() {
    if (!command) return
    setSent(true)
    const value = await op.run(() => mutateExpense(command.path, command.input))
    if (value && mounted.current) setResult(value.expense)
  }
  function clear() {
    setCommand(null)
    setResult(null)
    setReviewed(false)
    active.current = false
    op.clearError()
  }
  return (
    <Dialog
      description={t(
        'Expense commands retain the original amount and revision until confirmed.',
      )}
      open={!!command}
      title={t(
        result ? 'Expense command confirmed' : 'Confirm expense command',
      )}
      onClose={() => {
        if (result || !sent) clear()
      }}
    >
      <p className="text-sm mb-5">
        {t(
          'Keep the original command until the server confirms it. If the response is lost, retry this same command. Review history before discarding an unresolved command.',
        )}
      </p>
      <p className="font-medium mb-4 break-words">{command?.summary}</p>
      {op.error ? (
        <p role="alert" className="text-danger-ink mb-4">
          {copy(op.error)}
        </p>
      ) : null}
      {result ? (
        <>
          <p role="status" className="mb-4">
            {t('The retained expense history is confirmed.')}
          </p>
          <Button onClick={clear}>{t('Close')}</Button>
        </>
      ) : (
        <>
          <Button
            variant="primary"
            disabled={op.pending}
            onClick={() => void send()}
          >
            {t(op.error ? 'Retry original command' : 'Confirm and submit')}
          </Button>
          <label className="flex gap-3 text-sm mt-6">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            {t('I checked recorded history before discarding this command.')}
          </label>
          <Button
            className="mt-3"
            disabled={op.pending || (sent && !reviewed)}
            onClick={clear}
          >
            {t('Discard unresolved command')}
          </Button>
        </>
      )}
    </Dialog>
  )
}
