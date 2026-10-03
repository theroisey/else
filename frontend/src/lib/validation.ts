import { z } from 'zod'

// Every schema imports this configured instance before constructing objects.
// An entrypoint-only setting runs too late for shared production chunks.
z.config({ jitless: true })

export { z }
