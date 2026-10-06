// Explicitly limited to the disposable synthetic SQLite fixture helper.
import { execFileSync } from 'node:child_process'

export function database(sql: string) {
  const binary = process.env.AUTH_TEST_FIXTURE_BINARY
  const directory = process.env.AUTH_TEST_DIRECTORY
  if (!binary || !directory || !directory.split('/').at(-1)?.startsWith('else-browser-'))
    throw new Error('A disposable SQLite browser fixture is required.')
  return execFileSync(binary, [], { input: sql, encoding: 'utf8' }).trim()
}
