import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import {
  copy,
  currentLocale,
  i18n,
  languageNames,
  languages,
  localeStorageKey,
  resolveLocale,
  setLocale,
  useLocale,
} from './index'
import {
  formatPreciseTime,
  formatCalendarDate,
  formatCurrency,
  formatDecimal,
  formatNumber,
  formatPercent,
} from './format'
import {
  applyAccountLocale,
  readAccountLocale,
  saveAccountLocale,
} from './preferences'

afterEach(async () => {
  await act(() => setLocale('en', false))
  localStorage.clear()
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
  vi.unstubAllGlobals()
})
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })

it('uses an explicit supported preference, then browser base languages, then English', () => {
  expect(resolveLocale('ro', ['de-DE'])).toBe('ro')
  expect(resolveLocale('unknown', ['es-ES', 'TR-tr'])).toBe('tr')
  expect(resolveLocale(null, ['fr-CA'])).toBe('fr')
  expect(resolveLocale(null, ['zh-CN'])).toBe('en')
  expect(languageNames).toEqual({
    en: 'English',
    tr: 'Türkçe',
    ro: 'Română',
    de: 'Deutsch',
    fr: 'Français',
  })
})
it('switches mounted controls immediately, persists only the locale and returns readable missing copy', async () => {
  function Control() {
    useLocale()
    return <button>{copy('Save')}</button>
  }
  render(<Control />)
  for (const [locale, label] of [
    ['tr', 'Kaydet'],
    ['ro', 'Salvați'],
    ['de', 'Speichern'],
    ['fr', 'Enregistrer'],
  ] as const) {
    await act(() => setLocale(locale))
    expect(screen.getByRole('button', { name: label })).toBeVisible()
    expect(document.documentElement.lang).toBe(locale)
    expect(localStorage.getItem(localeStorageKey)).toBe(locale)
  }
  expect(copy('Unregistered readable fallback')).toBe(
    'Unregistered readable fallback',
  )
  expect(localStorage.length).toBe(1)
})
it('formats very large decimal values exactly and preserves the supplied currency in every locale', async () => {
  for (const locale of languages) {
    await setLocale(locale, false)
    const value = '9007199254740993.27'
    const expected = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value as unknown as number)
    expect(formatDecimal(value)).toBe(expected)
    expect(formatCurrency(value, 'USD', 2)).toContain('USD')
    expect(formatCurrency(value, 'EUR', 2)).toContain('EUR')
    expect(formatNumber('9007199254740993')).toBe(
      new Intl.NumberFormat(locale).format(9007199254740993n),
    )
  }
})
it('preserves UTC calendar days and exact percentage fractions', async () => {
  for (const locale of languages) {
    await setLocale(locale, false)
    const expected = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(new Date('2026-10-01T00:00:00Z'))
    expect(formatCalendarDate('2026-10-01')).toBe(expected)
    expect(formatCalendarDate('2026-10-01T00:00:00Z')).toBe(expected)
    expect(formatPercent('123456789012345678.123456')).toBe(
      new Intl.NumberFormat(locale, {
        style: 'percent',
        minimumFractionDigits: 6,
        maximumFractionDigits: 6,
      }).format('1234567890123456.78123456' as unknown as number),
    )
    if (locale !== 'en')
      expect(
        copy('Use up to 8000 characters; only line breaks are supported.'),
      ).not.toContain('Use up to')
  }
})
it('reads and saves only the authenticated account preference with CSRF and no cached credentials', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ data: { locale: null } }))
    .mockResolvedValueOnce(json({ data: { locale: 'ro' } }))
  vi.stubGlobal('fetch', fetcher)
  expect(await readAccountLocale(new AbortController().signal)).toBeNull()
  await saveAccountLocale('ro', new AbortController().signal)
  expect(fetcher.mock.calls[0]).toMatchObject([
    '/api/v1/auth/preferences',
    { credentials: 'same-origin', cache: 'no-store', redirect: 'error' },
  ])
  expect(fetcher.mock.calls[1]).toMatchObject([
    '/api/v1/auth/preferences',
    {
      method: 'PUT',
      body: '{"locale":"ro"}',
      headers: { 'X-CSRF-Token': 'a'.repeat(43) },
    },
  ])
  expect(localStorage.length).toBe(0)
})
it('does not let a late account lookup override a new user selection', async () => {
  let finish: (response: Response) => void = () => {}
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    ),
  )
  const lookup = applyAccountLocale(new AbortController().signal)
  await setLocale('tr')
  finish(json({ data: { locale: 'de' } }))
  await lookup
  expect(currentLocale()).toBe('tr')
})
it('does not apply a response from a session that has been cancelled', async () => {
  const controller = new AbortController()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      controller.abort()
      return Promise.resolve(json({ data: { locale: 'fr' } }))
    }),
  )
  await applyAccountLocale(controller.signal)
  expect(currentLocale()).toBe('en')
})

// Completion gate: every translated domain has full key and placeholder parity.
const english = import.meta.glob('./locales/en/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, string>>
const placeholders = (text: string) =>
  [...text.matchAll(/{{\s*([^}]+)\s*}}/g)].map((match) => match[1]).sort()
describe('complete domain catalogs', () => {
  it.each(['tr', 'ro', 'de', 'fr'] as const)(
    '%s has every source message and preserves interpolation',
    async (locale) => {
      await setLocale(locale, false)
      for (const [path, source] of Object.entries(english)) {
        const ns = path.split('/').at(-1)!.replace('.json', '')
        const target = i18n.getResourceBundle(locale, ns) as Record<
          string,
          string
        >
        expect(Object.keys(target).sort(), `${locale}/${ns}`).toEqual(
          Object.keys(source).sort(),
        )
        for (const [key, message] of Object.entries(target)) {
          expect(message.trim(), `${locale}/${ns}/${key}`).not.toBe('')
          expect(placeholders(message), `${locale}/${ns}/${key}`).toEqual(
            placeholders(key),
          )
        }
      }
    },
  )
})

it('translates owned bounds and currency validation without interpreting entered content', async () => {
  for (const locale of ['tr', 'ro', 'de', 'fr'] as const) {
    await setLocale(locale, false)
    expect(
      copy('Use 1–200 characters without control characters.'),
    ).not.toMatch(/^Use /)
    const scale = copy(
      'Use at most 3 decimal places for KWD. Amounts are never rounded.',
    )
    expect(scale).not.toMatch(/^Use at most/)
    expect(scale).toContain('KWD')
    expect(scale).toContain('3')
  }
})

it('keeps a new user choice while activation is pending instead of applying an older account response', async () => {
  const activate = i18n.changeLanguage.bind(i18n)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const changes = vi
    .spyOn(i18n, 'changeLanguage')
    .mockImplementation((locale) => {
      return locale === 'tr'
        ? pending.then(() => activate(locale))
        : activate(locale)
    })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(json({ data: { locale: 'de' } })),
  )
  const lookup = applyAccountLocale(new AbortController().signal)
  const choice = setLocale('tr')
  try {
    await vi.waitFor(() => expect(changes).toHaveBeenCalledWith('tr'))
    await lookup
    expect(changes).not.toHaveBeenCalledWith('de')
  } finally {
    release()
    await choice
  }
  expect(currentLocale()).toBe('tr')
  expect(localStorage.getItem(localeStorageKey)).toBe('tr')
})

it('localizes recorded schedules while retaining sub-millisecond precision and their timezone', async () => {
  for (const locale of languages) {
    await setLocale(locale, false)
    const decimal = new Intl.NumberFormat(locale)
      .formatToParts(0.5)
      .find((part) => part.type === 'decimal')!.value
    const value = '2026-11-01T06:30:00.000001Z'
    const local = formatPreciseTime(value, 'America/New_York')
    expect(local).toContain('1:30:00' + decimal + '000001')
    expect(formatPreciseTime(value, 'UTC')).toContain(
      '6:30:00' + decimal + '000001',
    )
    expect(local).not.toContain('2026-11-01T')
    expect(formatPreciseTime('2026-11-01T06:30:00.120000Z', 'UTC')).toContain(
      ':30:00' + decimal + '12',
    )
  }
})
