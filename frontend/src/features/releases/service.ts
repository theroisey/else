import { z } from '../../lib/validation'
import { APIError, authenticatedJSON } from '../../services/authenticated'

const revision = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .refine((v) => v !== '0'.repeat(40))
const builtAt = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine((v) => {
    const date = new Date(v)
    return (
      Number.isFinite(date.getTime()) &&
      date.getUTCFullYear() >= 2000 &&
      date.toISOString() === v.slice(0, 19) + '.000Z'
    )
  })
const runtime = z
  .discriminatedUnion('status', [
    z
      .object({
        status: z.literal('available'),
        version: z.string().max(44),
        commit_sha: revision,
        built_at: builtAt,
      })
      .strict(),
    z
      .object({
        status: z.literal('unavailable'),
        version: z.null(),
        commit_sha: z.null(),
        built_at: z.null(),
      })
      .strict(),
  ])
  .refine(
    (v) => v.status === 'unavailable' || v.version === 'sha-' + v.commit_sha,
  )
const reason = z.enum([
  'not_configured',
  'invalid_configuration',
  'authentication_failed',
  'access_denied',
  'rate_limited',
  'not_found',
  'timeout',
  'source_unreachable',
  'invalid_evidence',
  'digest_mismatch',
  'revision_mismatch',
  'repository_mismatch',
  'metadata_incomplete',
  'runtime_unidentified',
  'runtime_metadata_mismatch',
  'package_token_unsupported',
  'deployment_source_not_connected',
  'signature_not_verified',
])
const timestamp = z
  .string()
  .max(35)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) &&
      new Date(v).getUTCFullYear() >= 2000 &&
      new Date(v).toISOString().slice(0, 19) === v.slice(0, 19),
  )
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const artifact = z
  .object({
    commit_sha: revision,
    tag: z.string().max(44),
    image_reference: z
      .string()
      .max(260)
      .regex(
        /^ghcr\.io\/[a-z0-9][a-z0-9-]*\/[a-z0-9_][a-z0-9_.-]*@sha256:[0-9a-f]{64}$/,
      ),
    digest,
    built_at: timestamp,
    published_at: timestamp.nullable(),
    source: z.literal('github_ghcr'),
  })
  .strict()
  .refine(
    (v) =>
      v.tag === 'sha-' + v.commit_sha &&
      v.image_reference.endsWith('@' + v.digest),
  )
const attestation = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('present'),
      reason: z.literal('signature_not_verified'),
    })
    .strict(),
  z.object({ status: z.literal('unavailable'), reason }).strict(),
])
const observation = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      artifact,
      attestation: attestation.optional(),
    })
    .strict(),
  z
    .object({ status: z.literal('unavailable'), reason: reason.optional() })
    .strict(),
])
const report = z
  .object({
    data: z
      .object({
        runtime,
        latest_release: observation,
        image_provenance: observation,
        deployment: z
          .object({
            status: z.literal('unavailable'),
            reason: z.literal('deployment_source_not_connected').optional(),
          })
          .strict(),
        checked_at: timestamp.optional(),
      })
      .strict()
      .refine(
        (v) =>
          v.image_provenance.status === 'unavailable' ||
          (v.runtime.status === 'available' &&
            v.image_provenance.artifact.commit_sha === v.runtime.commit_sha &&
            v.image_provenance.artifact.built_at === v.runtime.built_at),
      ),
  })
  .strict()
export type ReleaseReport = z.infer<typeof report>['data']

export function parseReleaseReport(value: unknown): ReleaseReport {
  const result = report.safeParse(value)
  if (!result.success) throw new APIError(0, 'invalid_response')
  return result.data.data
}

export async function readReleaseReport(
  signal: AbortSignal,
  revalidate = false,
) {
  return parseReleaseReport(
    await authenticatedJSON('/api/v1/releases', {
      signal,
      revalidateRelease: revalidate,
    }),
  )
}
