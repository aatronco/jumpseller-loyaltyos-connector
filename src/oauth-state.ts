// Single-process, in-memory CSRF state store for the OAuth flow (Phase 1).
// NOT multi-instance safe — replace with a shared store (Redis/DB) for Phase 2.
const states = new Map<string, number>()
const TTL_MS = 10 * 60 * 1000

export function createState(value: string): void {
  states.set(value, Date.now() + TTL_MS)
}

export function consumeState(value: string): boolean {
  const expiresAt = states.get(value)
  if (expiresAt === undefined) return false
  states.delete(value)
  return expiresAt > Date.now()
}
