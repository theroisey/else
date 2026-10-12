import { z } from '../../lib/validation'
export const automationFailure = z
  .object({
    error_code: z
      .string()
      .regex(/^[a-z_]+$/)
      .max(100),
    failed_at: z.string().datetime(),
    retry_after: z.string().datetime(),
  })
  .strict()
  .nullable()
