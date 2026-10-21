// Identity syntax only; existing server session documents stay byte-preserved.
export function isAccountEmail(value: string) {
  const email = value.trim().toLowerCase()
  const local = email.split('@')[0] ?? ''
  return (
    email.length <= 254 &&
    local.length > 0 &&
    local.length <= 64 &&
    !local.startsWith('.') &&
    !local.endsWith('.') &&
    !local.includes('..') &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      email,
    )
  )
}
