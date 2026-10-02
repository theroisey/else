import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RefObject } from 'react'
import { useNavigate } from 'react-router'
import { Button, Dialog } from '../../components/ui'
import { useAuth } from '../auth/auth-context'
import { useRecordOperations } from '../auth/useRecordOperations'
import { APIError } from '../../services/authenticated'
import { billingPermissions } from './hooks'
import { RecoveryContext } from './payment-recovery-context'
import type { Command } from './payment-recovery-context'
import { pagePath } from './models'
import { money } from './money'
import * as api from './service'
interface Attempt {
  command: Command
  state: 'sending' | 'uncertain' | 'rejected' | 'confirmed'
  message: string
  uncertain: boolean
  cursor: string
  checked: boolean
}
// Lives above routes: Back and other navigation cannot discard an unresolved command.
// Identity/grant changes unmount the private command, just like the private query partition.
export function PaymentRecoveryBoundary({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const handler = useRef<((command: Command) => void) | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <RecoveryContext
      value={{ busy, submit: (command) => handler.current?.(command) }}
    >
      {children}
      <PaymentRecoveryController
        key={
          auth.session?.user.id +
          ':' +
          JSON.stringify(auth.session?.user.permissions ?? [])
        }
        handler={handler}
        onBusy={setBusy}
      />
    </RecoveryContext>
  )
}
function PaymentRecoveryController({
  handler,
  onBusy,
}: {
  handler: RefObject<((command: Command) => void) | null>
  onBusy: (busy: boolean) => void
}) {
  const operation = useRecordOperations('billing'),
    navigate = useNavigate(),
    active = useRef(false),
    mounted = useRef(true)
  const [attempt, setAttempt] = useState<Attempt | null>(null),
    [checking, setChecking] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      handler.current = null
      onBusy(false)
    }
  }, [handler, onBusy])
  useEffect(() => {
    onBusy(attempt !== null)
  }, [attempt, onBusy])
  useEffect(() => {
    handler.current = (command) => {
      if (!attempt && !active.current) void execute(command, false)
    }
    return () => {
      handler.current = null
    }
  })
  useEffect(() => {
    if (!attempt || ['confirmed', 'rejected'].includes(attempt.state)) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [attempt])
  async function execute(command: Command, wasUncertain: boolean) {
    if (active.current) return
    if (
      !billingPermissions(
        operation.auth.session?.user.permissions ?? [],
        command.client,
      ).update
    )
      return
    active.current = true
    setAttempt({
      command,
      state: 'sending',
      message: 'Recording the original payment command…',
      uncertain: wasUncertain,
      cursor: '',
      checked: false,
    })
    try {
      const result = await operation.read(() =>
        api.recordPayment(
          command.client,
          command.id,
          command.payment,
          command.revision,
        ),
      )
      if (!mounted.current) return
      await operation.cache.invalidateQueries({
        queryKey: ['billing', operation.auth.session?.user.id],
      })
      if (mounted.current)
        setAttempt({
          command,
          state: 'confirmed',
          message: result.replayed
            ? 'Previously recorded payment confirmed. No second payment was created.'
            : 'Payment recorded.',
          uncertain: false,
          cursor: '',
          checked: false,
        })
    } catch (error) {
      if (!mounted.current) return
      const uncertain =
        wasUncertain ||
        !(error instanceof APIError) ||
        (error.status === 0 && error.code !== 'invalid_request') ||
        error.status >= 500
      setAttempt({
        command,
        state: uncertain ? 'uncertain' : 'rejected',
        message: uncertain
          ? 'The payment outcome is unconfirmed. Keep this page open. Retry only this original command or check its recorded history before making another payment.'
          : error instanceof APIError
            ? error.message
            : 'Unable to record payment.',
        uncertain,
        cursor: '',
        checked: false,
      })
    } finally {
      active.current = false
    }
  }
  async function checkHistory() {
    if (!attempt || checking || active.current) return
    setChecking(true)
    const { command } = attempt
    try {
      const page = await operation.read(() =>
        api.payments(command.client, command.id, attempt.cursor),
      )
      if (!mounted.current) return
      const found = page.data.find(
        (p) => p.command_id === command.payment.command_id,
      )
      if (
        found &&
        found.recorded_by === operation.auth.session?.user.id &&
        found.collection_revision === String(BigInt(command.revision) + 1n) &&
        Object.entries(command.payment).every(
          ([key, value]) =>
            found[key as keyof typeof command.payment] === value,
        )
      ) {
        await operation.cache.invalidateQueries({
          queryKey: ['billing', operation.auth.session?.user.id],
        })
        if (mounted.current)
          setAttempt({
            ...attempt,
            state: 'confirmed',
            message:
              'Previously recorded payment confirmed in history. No second payment was created.',
            uncertain: false,
          })
      } else
        setAttempt({
          ...attempt,
          cursor: page.page.next_cursor ?? '',
          checked: true,
          message: found
            ? 'This command conflicts with recorded history. Reconcile it with an authorized finance operator before recording another payment.'
            : page.page.next_cursor
              ? 'Original command not found on this history page. Check the next page or retry the identical command.'
              : 'Original command was not found in the checked history. Its outcome remains unconfirmed. Retry the identical command; if reconciliation remains blocked, contact an authorized finance operator. Do not create a replacement payment.',
        })
    } catch {
      if (mounted.current)
        setAttempt({
          ...attempt,
          message:
            'Unable to check payment history. The original command remains available for an identical retry.',
        })
    } finally {
      setChecking(false)
    }
  }
  function close() {
    if (!attempt || !['confirmed', 'rejected'].includes(attempt.state)) return
    const { command } = attempt
    setAttempt(null)
    navigate(pagePath(command.client, command.id), { replace: true })
    void operation.cache.invalidateQueries({
      queryKey: ['billing', operation.auth.session?.user.id],
    })
  }
  return (
    <>
      {attempt ? (
        <Dialog
          open
          title={
            attempt.state === 'confirmed'
              ? 'Payment confirmed'
              : attempt.state === 'rejected'
                ? 'Payment not recorded'
                : 'Confirming payment'
          }
          eyebrow="Payment collection"
          description={attempt.message}
          onClose={close}
        >
          <p className="mt-4 text-sm">
            {money(
              attempt.command.payment.amount_minor,
              attempt.command.payment.currency,
            )}{' '}
            · {attempt.command.payment.paid_on}
          </p>
          <p className="mt-2 text-xs text-muted">
            References and notes are hidden. Financial drafts are kept only in
            memory. Leaving or reloading discards this recovery command;
            reconcile recorded history before any replacement payment.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {attempt.state === 'sending' ? (
              <p role="status" aria-busy="true">
                Waiting for confirmation…
              </p>
            ) : attempt.state === 'uncertain' ? (
              <>
                <Button
                  variant="primary"
                  disabled={checking}
                  onClick={() => void execute(attempt.command, true)}
                >
                  Retry original payment
                </Button>
                <Button
                  disabled={checking}
                  loading={checking}
                  onClick={() => void checkHistory()}
                >
                  {attempt.checked && attempt.cursor
                    ? 'Check next history page'
                    : 'Check recorded payments'}
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={close}>
                {attempt.state === 'confirmed'
                  ? 'Return to collection'
                  : 'Reload collection before retrying'}
              </Button>
            )}
          </div>
        </Dialog>
      ) : null}
    </>
  )
}
