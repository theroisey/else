import { copy, useLocale } from '../../i18n/index'
import { LanguageControl } from '../../i18n/LanguageControl'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowRightFromBracket,
  faChevronDown,
  faUser,
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
        <span className="account-mobile-icon" aria-hidden="true">
          <FontAwesomeIcon icon={faUser} />
        </span>
        <span className="account-name truncate">
          {auth.session?.user.display_name}
        </span>
        <span
          className="account-chevron text-[0.5rem] text-muted"
          aria-hidden="true"
        >
          <FontAwesomeIcon icon={faChevronDown} />
        </span>
      </summary>
      <div className="account-popup">
        <p className="break-all text-sm text-muted">
          {`${auth.session?.user.display_name} · ${auth.session?.user.email}`}
        </p>
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
