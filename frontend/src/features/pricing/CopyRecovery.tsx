import { useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useNavigate } from 'react-router'
import { Button, Dialog } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { useAuth } from '../auth/auth-context'
import { useRecordOperations } from '../auth/useRecordOperations'
import { money } from '../billing/money'
import { pagePath } from './models'
import { pricingPermissions } from './hooks'
import { CopyRecoveryContext } from './copy-recovery-context'
import type { CopyCommand } from './copy-recovery-context'
import * as api from './service'
interface Attempt {
  command: CopyCommand
  state: 'sending' | 'unknown' | 'confirmed' | 'rejected'
  message: string
  collection: string
}
export function CopyRecoveryBoundary({ children }: { children: ReactNode }) {
  const auth = useAuth(),
    handler = useRef<((c: CopyCommand) => void) | null>(null),
    [busy, setBusy] = useState(false)
  return (
    <CopyRecoveryContext value={{ busy, submit: (c) => handler.current?.(c) }}>
      {children}
      <Controller
        key={
          auth.session?.user.id +
          ':' +
          JSON.stringify(auth.session?.user.permissions ?? [])
        }
        handler={handler}
        onBusy={setBusy}
      />
    </CopyRecoveryContext>
  )
}
function Controller({
  handler,
  onBusy,
}: {
  handler: RefObject<((c: CopyCommand) => void) | null>
  onBusy: (busy: boolean) => void
}) {
  const op = useRecordOperations('pricing'),
    navigate = useNavigate(),
    active = useRef(false),
    mounted = useRef(true),
    [attempt, setAttempt] = useState<Attempt | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      handler.current = null
      onBusy(false)
    }
  }, [handler, onBusy])
  useEffect(() => {
    onBusy(!!attempt)
  }, [attempt, onBusy])
  useEffect(() => {
    handler.current = (c) => {
      if (!attempt && !active.current) void execute(c, false)
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
  async function execute(command: CopyCommand, unknown: boolean) {
    if (
      active.current ||
      !pricingPermissions(
        op.auth.session?.user.permissions ?? [],
        command.client,
      ).copy
    )
      return
    active.current = true
    setAttempt({
      command,
      state: 'sending',
      message: 'Creating the original collection command…',
      collection: '',
    })
    try {
      const r = await op.read(() =>
        api.copy(
          command.client,
          command.sheet,
          command.version,
          command.revision,
          command.input,
        ),
      )
      if (!mounted.current) return
      await Promise.all([
        op.cache.invalidateQueries({
          queryKey: ['pricing', op.auth.session?.user.id],
        }),
        op.cache.invalidateQueries({
          queryKey: ['billing', op.auth.session?.user.id],
        }),
      ])
      if (mounted.current)
        setAttempt({
          command,
          state: 'confirmed',
          message: r.replayed
            ? 'Previously created collection confirmed. No duplicate collection was created.'
            : 'Collection created with immutable pricing terms.',
          collection: r.id,
        })
    } catch (e) {
      if (!mounted.current) return
      const uncertain =
        unknown ||
        !(e instanceof APIError) ||
        e.status >= 500 ||
        (e.status === 0 && e.code !== 'invalid_request')
      setAttempt({
        command,
        state: uncertain ? 'unknown' : 'rejected',
        message: uncertain
          ? 'Collection outcome is unconfirmed. Retry only the identical original command. A conflict does not prove that the first attempt failed. Do not create a replacement; reconcile with an authorized finance operator if retry remains blocked.'
          : e instanceof APIError
            ? e.message
            : 'Unable to create collection.',
        collection: '',
      })
    } finally {
      active.current = false
    }
  }
  function close() {
    if (!attempt || !['confirmed', 'rejected'].includes(attempt.state)) return
    const a = attempt
    setAttempt(null)
    navigate(
      a.state === 'confirmed'
        ? `/app/clients/${a.command.client}/billing/${a.collection}`
        : pagePath(a.command.client, a.command.sheet),
      { replace: true },
    )
  }
  return attempt ? (
    <Dialog
      open
      title={
        attempt.state === 'confirmed'
          ? 'Collection confirmed'
          : attempt.state === 'rejected'
            ? 'Collection not created'
            : 'Confirming collection'
      }
      eyebrow="Immutable pricing copy"
      description={attempt.message}
      onClose={close}
    >
      <p className="mt-4 text-sm">
        {money(attempt.command.total, attempt.command.currency)} ·{' '}
        {attempt.command.input.billing_date}
      </p>
      <p className="mt-3 text-xs text-muted">
        Notes are hidden. Recovery is kept only in memory. Reload, sign out or
        access changes discard the original command; reconcile retained history
        before a replacement.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {attempt.state === 'sending' ? (
          <p role="status" aria-busy="true">
            Waiting for confirmation…
          </p>
        ) : attempt.state === 'unknown' ? (
          <Button
            variant="primary"
            onClick={() => void execute(attempt.command, true)}
          >
            Retry original collection
          </Button>
        ) : (
          <Button variant="primary" onClick={close}>
            {attempt.state === 'confirmed'
              ? 'Open collection'
              : 'Review current pricing'}
          </Button>
        )}
      </div>
    </Dialog>
  ) : null
}
