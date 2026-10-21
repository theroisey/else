import { copy, useLocale } from '../../i18n/index'
import { LanguageControl } from '../../i18n/LanguageControl'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router'
import { Brand } from '../../components/brand/Brand'
import { AppearanceControl } from '../appearance/Appearance'
import { faArrowRightToBracket } from '@fortawesome/free-solid-svg-icons'
import { Button, TextField } from '../../components/ui'
import { safeReturnTo } from '../shell/navigation'
import { useAuth } from './auth-context'
import { isAccountEmail } from './email'
import { AuthError, requestCode } from './auth-service'
import type { OtpChallenge } from './auth-service'
import { AuthPending, AuthUnavailable } from './AuthGuard'
import { warmWorkspace } from '../../app/prefetch'

export function LoginPage() {
  useLocale()
  const auth = useAuth()
  const location = useLocation()
  const emailRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const target = useRef('')
  const active = useRef(false)
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null)
  const [issued, setIssued] = useState(0)
  const [now, setNow] = useState(0)
  const [errors, setErrors] = useState({ email: '', code: '' })
  const [maskedEmail, setMaskedEmail] = useState('')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const remaining = challenge
    ? Math.max(0, challenge.expires_in - Math.floor((now - issued) / 1000))
    : 0
  const cooldown = challenge
    ? Math.max(0, challenge.resend_after - Math.floor((now - issued) / 1000))
    : 0
  useEffect(() => {
    if (!challenge) return
    codeRef.current?.focus()
    const tick = window.setInterval(() => setNow(performance.now()), 1000)
    return () => window.clearInterval(tick)
  }, [challenge])
  useEffect(
    () => () => {
      if (codeRef.current) codeRef.current.value = ''
      target.current = ''
    },
    [],
  )

  if (auth.status === 'checking') return <AuthPending />
  if (auth.status === 'unavailable') return <AuthUnavailable />
  if (auth.status === 'signed-in')
    return <Navigate to={safeReturnTo(location.state?.returnTo)} replace />

  function failure(error: unknown) {
    setMessage(
      error instanceof AuthError
        ? error.message
        : 'Unable to sign in. Try again.',
    )
  }
  async function send(email: string) {
    if (active.current) return
    active.current = true
    setPending(true)
    setMessage('')
    try {
      const next = await requestCode(email)
      target.current = email
      setMaskedEmail(email.replace(/^(.).*(@.*)$/u, '$1•••$2'))
      const time = performance.now()
      setIssued(time)
      setNow(time)
      setChallenge(next)
      if (codeRef.current) codeRef.current.value = ''
      warmWorkspace(safeReturnTo(location.state?.returnTo))
    } catch (error) {
      failure(error)
    } finally {
      active.current = false
      setPending(false)
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (active.current) return
    setMessage('')
    if (!challenge) {
      const email = (emailRef.current?.value ?? '').trim().toLowerCase()
      if (!isAccountEmail(email)) {
        setErrors({ email: 'Enter your email address.', code: '' })
        emailRef.current?.focus()
        return
      }
      setErrors({ email: '', code: '' })
      await send(email)
      return
    }
    const code = codeRef.current?.value ?? ''
    if (!/^[0-9]{6}$/.test(code)) {
      setErrors({ email: '', code: 'Enter the six-digit verification code.' })
      codeRef.current?.focus()
      return
    }
    if (codeRef.current) codeRef.current.value = ''
    setErrors({ email: '', code: '' })
    active.current = true
    setPending(true)
    try {
      await auth.verifyCode(challenge.challenge_id, code)
    } catch (error) {
      failure(error)
      window.requestAnimationFrame(() => codeRef.current?.focus())
    } finally {
      active.current = false
      setPending(false)
    }
  }
  function anotherEmail() {
    if (active.current) return
    if (codeRef.current) codeRef.current.value = ''
    setChallenge(null)
    setMessage('')
    setErrors({ email: '', code: '' })
    target.current = ''
    window.requestAnimationFrame(() => emailRef.current?.focus())
  }

  return (
    <div className="login-page">
      <header className="login-header">
        <Brand />
      </header>
      <main className="login-main">
        <div className="login-editorial">
          <p className="eyebrow mb-7">
            {copy('Roisey Else · Private operations', 'auth')}
          </p>
          <h2>{copy('Precision in every part of business.', 'auth')}</h2>
          <p className="mt-6 max-w-xs text-sm leading-7 text-muted">
            {copy(
              'A considered workspace for client relationships, financial clarity and the work that matters.',
              'auth',
            )}
          </p>
          <p className="mt-10 text-[0.625rem] uppercase tracking-[0.18em] text-muted">
            {copy('Relationships / Operations / Intelligence', 'auth')}
          </p>
        </div>
        <section className="w-full" aria-labelledby="login-title">
          <p className="eyebrow">{copy('Your workspace', 'auth')}</p>
          <h1
            id="login-title"
            className="mt-3 text-3xl font-display font-normal tracking-tight"
          >
            {copy(challenge ? 'Check your email' : 'Sign in', 'auth')}
          </h1>
          <p className="mt-3 leading-6 text-muted">
            {copy(
              challenge
                ? 'If this address belongs to an active account, a verification code will arrive shortly.'
                : 'Enter your registered email. We will send a single-use sign-in code.',
              'auth',
            )}
            {challenge ? (
              <span className="mt-2 block break-all font-medium text-foreground">
                {maskedEmail}
              </span>
            ) : null}
          </p>
          {auth.expired ? (
            <p
              className="mt-5 rounded-sm border border-warning-line bg-warning-surface p-3 text-warning-ink"
              role="status"
            >
              {copy('Your session ended. Sign in again to continue.', 'auth')}
            </p>
          ) : null}
          <form
            className="login-form"
            onSubmit={(event) => {
              void submit(event)
            }}
            noValidate
            aria-busy={pending}
          >
            {!challenge ? (
              <TextField
                ref={emailRef}
                label={copy('Email', 'auth')}
                name="email"
                enterKeyHint="next"
                type="email"
                autoComplete="username"
                maxLength={254}
                autoCapitalize="none"
                spellCheck={false}
                required
                error={copy(errors.email, 'auth')}
                disabled={pending}
              />
            ) : (
              <>
                <TextField
                  ref={codeRef}
                  label={copy('Verification code', 'auth')}
                  name="code"
                  enterKeyHint="go"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  spellCheck={false}
                  className="text-center font-mono text-2xl tracking-[0.35em] tabular-nums"
                  onInput={(event) => {
                    event.currentTarget.value = event.currentTarget.value
                      .replace(/[^0-9]/g, '')
                      .slice(0, 6)
                  }}
                  error={copy(errors.code, 'auth')}
                  disabled={pending}
                />
                <p className="text-xs text-muted" role="status" aria-live="off">
                  {remaining
                    ? `${copy('Code expires in', 'auth')} ${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`
                    : copy(
                        'Your code has expired. Request a new code.',
                        'auth',
                      )}
                </p>
              </>
            )}
            {message ? (
              <p className="text-sm leading-6 text-danger-ink" role="alert">
                {copy(message, 'auth')}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              icon={faArrowRightToBracket}
              loading={pending}
              loadingLabel={copy(
                challenge ? 'Verifying code…' : 'Sending code…',
                'auth',
              )}
              disabled={Boolean(challenge && !remaining)}
            >
              {copy(
                challenge ? 'Verify and sign in' : 'Continue with email',
                'auth',
              )}
            </Button>
            {challenge ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button
                  variant="ghost"
                  disabled={pending || cooldown > 0}
                  onClick={() => {
                    void send(target.current)
                  }}
                >
                  {cooldown
                    ? `${copy('Resend code in', 'auth')} ${cooldown}s`
                    : copy('Send a new code', 'auth')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={anotherEmail}
                >
                  {copy('Use another email', 'auth')}
                </Button>
              </div>
            ) : null}
            <p className="text-xs leading-6 text-muted">
              {copy(
                'No email? Check spam or contact your administrator. Never share your code.',
                'auth',
              )}
            </p>
          </form>
        </section>
      </main>
      <footer className="login-footer">
        <div className="login-preferences">
          <AppearanceControl variant="text" />
          <LanguageControl variant="text" />
        </div>
        <span>{copy('Roisey Else · Authorized access', 'auth')}</span>
      </footer>
    </div>
  )
}
