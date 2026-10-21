import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect } from '@playwright/test'

export async function completeEmailSignIn(page) {
  const email = await page.getByLabel('Email', { exact: true }).inputValue()
  // Independent workflow scenarios reuse synthetic identities, without waiting a real 15-minute abuse window.
  const directory = process.env.AUTH_TEST_DIRECTORY
  const fixture = process.env.AUTH_TEST_FIXTURE_BINARY
  if (!directory?.split('/').at(-1)?.startsWith('else-browser-') || !fixture)
    throw new Error('Owned browser fixture required')
  execFileSync(fixture, [], {
    input: 'DELETE FROM auth_otp_rate_events;',
    encoding: 'utf8',
  })
  const requested = Date.now()
  await page
    .getByRole('button', { name: 'Continue with email', exact: true })
    .click()
  await expect(
    page.getByLabel('Verification code', { exact: true }),
  ).toBeVisible()
  const root = process.env.AUTH_TEST_MAIL_ROOT
  if (!root || !root.split('/').at(-1)?.startsWith('else-otp-'))
    throw new Error('Controlled SMTP fixture required')
  const read = () => {
    try {
      const container = process.env.AUTH_TEST_MAIL_CONTAINER
      return container
        ? JSON.parse(
            execFileSync(
              process.env.DOCKER ?? 'docker',
              [
                'exec',
                container,
                process.env.AUTH_TEST_MAIL_BINARY,
                'smtp-read',
                root,
                email,
              ],
              { encoding: 'utf8' },
            ),
          )
        : (JSON.parse(readFileSync(root + '/messages.json', 'utf8'))[email] ??
            {})
    } catch {
      return {}
    }
  }
  await expect
    .poll(() => read().received_at ?? 0)
    .toBeGreaterThanOrEqual(requested)
  await page.getByLabel('Verification code', { exact: true }).fill(read().code)
  await page
    .getByRole('button', { name: 'Verify and sign in', exact: true })
    .click()
}
