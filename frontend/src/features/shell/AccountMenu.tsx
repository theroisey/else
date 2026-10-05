import { copy, useLocale } from '../../i18n/index'
import { LanguageControl } from '../../i18n/LanguageControl'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowRightFromBracket,
  faChevronDown,
} from '@fortawesome/free-solid-svg-icons'
import { Button } from '../../components/ui'
import { useAuth } from '../auth/auth-context'
import { AppearanceControl } from '../appearance/Appearance'
import { AuthError } from '../auth/auth-service'

export function AccountMenu() {
  useLocale()
  const accountRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !accountRef.current?.contains(event.target) &&
        accountRef.current
      )
        accountRef.current.open = false
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [])
  const auth = useAuth()
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function signOut() {
    if (pending) return
    setPending(true)
    setError('')
    try {
      await auth.logout()
      navigate('/login', { replace: true })
    } catch (failure) {
      setError(
        failure instanceof AuthError
          ? failure.message
          : 'Unable to sign out. Try again.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <details
      ref={accountRef}
      className="relative min-w-0 max-w-48"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false
          event.currentTarget.querySelector('summary')?.focus()
        }
      }}
    >
      <summary
        className="account-trigger"
        aria-label={copy('Account', 'common')}
      >
        <span className="truncate">{auth.session?.user.display_name}</span>
        <FontAwesomeIcon
          className="text-[0.5rem] text-muted"
          icon={faChevronDown}
          aria-hidden="true"
        />
      </summary>
      <div className="account-popup">
        <p className="break-all text-sm text-muted">
          {auth.session?.user.email}
        </p>
        <Link
          className="min-h-8 py-1 font-semibold underline underline-offset-4"
          to="/app/access"
          onClick={(event) => {
            event.currentTarget.closest('details')?.removeAttribute('open')
          }}
        >
          {copy('My access', 'common')}
        </Link>
        <AppearanceControl />
        <LanguageControl />
        <Button
          icon={faArrowRightFromBracket}
          loading={pending}
          loadingLabel={copy('Signing out', 'common')}
          onClick={() => {
            void signOut()
          }}
        >
          {copy('Sign out', 'common')}
        </Button>
        {error ? (
          <p className="text-sm leading-6 text-danger-ink" role="alert">
            {copy(error, 'common')}
          </p>
        ) : null}
      </div>
    </details>
  )
}
