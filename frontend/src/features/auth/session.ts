export interface Grant {
  permission: string
  scope: 'global' | 'client'
  client_id?: string
}

export interface Session {
  user: { id: string; email: string; display_name: string; permissions: Grant[] }
  session: { expires_at: string }
}

export const sessionKey = ['auth', 'session'] as const

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isUUID(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    && value !== '00000000-0000-0000-0000-000000000000'
}

export function parseSession(body: unknown): Session {
  if (!isRecord(body) || !isRecord(body.data)) throw new Error('Invalid identity response.')
  const { user, session } = body.data
  if (!isRecord(user) || !isRecord(session) || !isUUID(user.id)
    || typeof user.email !== 'string' || !user.email || user.email.length > 254
    || typeof user.display_name !== 'string' || !user.display_name || user.display_name.length > 100
    || !Array.isArray(user.permissions) || user.permissions.length > 10_000
    || typeof session.expires_at !== 'string' || !Number.isFinite(Date.parse(session.expires_at))) {
    throw new Error('Invalid identity response.')
  }
  const permissions: Grant[] = user.permissions.map((grant: unknown) => {
    if (!isRecord(grant) || typeof grant.permission !== 'string'
      || !/^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,31}$/.test(grant.permission)
      || (grant.scope !== 'global' && grant.scope !== 'client')
      || (grant.scope === 'global' && grant.client_id !== undefined)
      || (grant.scope === 'client' && !isUUID(grant.client_id))) throw new Error('Invalid identity response.')
    return grant.scope === 'client'
      ? { permission: grant.permission, scope: grant.scope, client_id: grant.client_id as string }
      : { permission: grant.permission, scope: grant.scope }
  })
  return {
    user: { id: user.id, email: user.email, display_name: user.display_name, permissions },
    session: { expires_at: session.expires_at },
  }
}
