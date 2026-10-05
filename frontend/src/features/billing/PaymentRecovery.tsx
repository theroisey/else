import { formatCalendarDate } from '../../i18n/format'
import { copy, useLocale } from '../../i18n/index'
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
  useLocale()
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
  useLocale()
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
      message: copy('Recording the original payment command…', 'billing'),
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
            ? copy(
                'Previously recorded payment confirmed. No second payment was created.',
                'billing',
              )
            : copy('Payment recorded.', 'billing'),
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
          ? copy(
              'The payment outcome is unconfirmed. Keep this page open. Retry only this original command or check its recorded history before making another payment.',
              'billing',
            )
          : error instanceof APIError
            ? error.message
            : copy('Unable to record payment.', 'billing'),
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
            message: copy(
              'Previously recorded payment confirmed in history. No second payment was created.',
              'billing',
            ),
            uncertain: false,
          })
      } else
        setAttempt({
          ...attempt,
          cursor: page.page.next_cursor ?? '',
          checked: true,
          message: found
            ? copy(
                'This command conflicts with recorded history. Reconcile it with an authorized finance operator before recording another payment.',
                'billing',
              )
            : page.page.next_cursor
              ? copy(
                  'Original command not found on this history page. Check the next page or retry the identical command.',
                  'billing',
                )
              : copy(
                  'Original command was not found in the checked history. Its outcome remains unconfirmed. Retry the identical command; if reconciliation remains blocked, contact an authorized finance operator. Do not create a replacement payment.',
                  'billing',
                ),
        })
    } catch {
      if (mounted.current)
        setAttempt({
          ...attempt,
          message: copy(
            'Unable to check payment history. The original command remains available for an identical retry.',
            'billing',
          ),
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
              ? copy('Payment confirmed', 'billing')
              : attempt.state === 'rejected'
                ? copy('Payment not recorded', 'billing')
                : copy('Confirming payment', 'billing')
          }
          eyebrow={copy('Payment collection', 'billing')}
          description={copy(attempt.message, 'billing')}
          onClose={close}
        >
          <p className="mt-4 text-sm">
            {money(
              attempt.command.payment.amount_minor,
              attempt.command.payment.currency,
            )}{' '}
            · {formatCalendarDate(attempt.command.payment.paid_on)}
          </p>
          <p className="mt-2 text-xs text-muted">
            {copy(
              'References and notes are hidden. Financial drafts are kept only in memory. Leaving or reloading discards this recovery command; reconcile recorded history before any replacement payment.',
              'billing',
            )}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {attempt.state === 'sending' ? (
              <p role="status" aria-busy="true">
                {copy('Waiting for confirmation…', 'billing')}
              </p>
            ) : attempt.state === 'uncertain' ? (
              <>
                <Button
                  variant="primary"
                  disabled={checking}
                  onClick={() => void execute(attempt.command, true)}
                >
                  {copy('Retry original payment', 'billing')}
                </Button>
                <Button
                  disabled={checking}
                  loading={checking}
                  onClick={() => void checkHistory()}
                >
                  {attempt.checked && attempt.cursor
                    ? copy('Check next history page', 'billing')
                    : copy('Check recorded payments', 'billing')}
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={close}>
                {attempt.state === 'confirmed'
                  ? copy('Return to collection', 'billing')
                  : copy('Reload collection before retrying', 'billing')}
              </Button>
            )}
          </div>
        </Dialog>
      ) : null}
    </>
  )
}
