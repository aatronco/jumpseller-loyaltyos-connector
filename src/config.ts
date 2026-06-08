import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  APP_URL: z.string().url(),
  JUMPSELLER_APP_ID: z.string().min(1),
  JUMPSELLER_APP_SECRET: z.string().min(1),
  JUMPSELLER_SCOPES: z
    .string()
    .default('read_orders read_customers write_promotions write_jsapps write_hooks read_store'),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex chars (32 bytes)'),
  LOYALTYOS_API_URL: z.string().url().default('http://localhost:3002'),
  LOYALTYOS_API_KEY: z.string().default('dev-key'),
  LOYALTYOS_PROGRAM_ID: z.string().default('prog_dev'),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${details}`)
  }
  return parsed.data
}
