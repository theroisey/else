import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useLocation } from 'react-router'
import { Brand } from '../../components/brand/Brand'
import { AppearanceControl } from '../appearance/Appearance'
import { faArrowRightToBracket } from '@fortawesome/free-solid-svg-icons'
import { Button, TextField, buttonStyles } from '../../components/ui'
import { safeReturnTo } from '../shell/navigation'
import { useAuth } from './auth-context'
import { AuthError } from './auth-service'
import { AuthPending, AuthUnavailable } from './AuthGuard'

export function LoginPage() {
  const auth = useAuth()
  const location = useLocation()
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState({ email: '', password: '' })
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)

  if (auth.status === 'checking') return <AuthPending />
  if (auth.status === 'unavailable') return <AuthUnavailable />
  if (auth.status === 'signed-in') return <Navigate to={safeReturnTo(location.state?.returnTo)} replace />

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const invalidEmail = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.trim().length > 254
    const invalidPassword = !password || new TextEncoder().encode(password).length > 128
    setErrors({ email: invalidEmail ? 'Enter your email address.' : '', password: invalidPassword ? 'Enter a password of no more than 128 bytes.' : '' })
    setMessage('')
    if (invalidEmail || invalidPassword) {
      if (invalidEmail) emailRef.current?.focus()
      else passwordRef.current?.focus()
      return
    }
    const submittedPassword = password
    setPassword('')
    setPending(true)
    try {
      await auth.login(email.trim().toLowerCase(), submittedPassword)
    } catch (error) {
      setMessage(error instanceof AuthError ? error.message : 'Unable to sign in. Try again.')
      window.requestAnimationFrame(() => passwordRef.current?.focus())
    } finally {
      setPending(false)
    }
  }

  return <div className="login-page">
    <header className="login-header"><Brand /><AppearanceControl /></header>
    <main className="login-main">
      <div className="login-editorial"><p className="eyebrow mb-7">Roisey Else · Private operations</p><h2>Precision in every<br />part of business.</h2><p className="mt-6 max-w-xs text-sm leading-7 text-muted">A considered workspace for client relationships, financial clarity and the work that matters.</p><p className="mt-10 text-[0.625rem] uppercase tracking-[0.18em] text-muted">Relationships / Operations / Intelligence</p></div>
      <section className="w-full" aria-labelledby="login-title">
        <p className="eyebrow">Your workspace</p>
        <h1 id="login-title" className="mt-3 text-3xl font-display font-normal tracking-tight">Sign in</h1>
        <p className="mt-3 leading-6 text-muted">Use your Roisey Else account to continue.</p>
        {auth.expired ? <p className="mt-5 rounded-sm border border-warning-line bg-warning-surface p-3 text-warning-ink" role="status">Your session ended. Sign in again to continue.</p> : null}
        <form className="login-form" onSubmit={(event) => { void submit(event) }} noValidate aria-busy={pending}>
          <TextField ref={emailRef} label="Email" name="email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} error={errors.email} disabled={pending} />
          <TextField ref={passwordRef} label="Password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} error={errors.password} disabled={pending} />
          {message ? <p className="text-sm leading-6 text-danger-ink" role="alert">{message}</p> : null}
          <Button type="submit" variant="primary" icon={faArrowRightToBracket} loading={pending} loadingLabel="Signing in">Sign in</Button>
        </form>
      </section>
    </main>
    <footer className="login-footer"><span>Roisey Else · Authorized access</span><Link className={buttonStyles({ variant: 'ghost', size: 'compact' })} to="/service-status">Service status</Link></footer>
  </div>
}
