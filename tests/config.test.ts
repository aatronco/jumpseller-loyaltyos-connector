import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

const valid = {
  APP_URL: 'https://example.app.github.dev',
  JUMPSELLER_APP_ID: 'app-id',
  JUMPSELLER_APP_SECRET: 'app-secret',
  TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
}

describe('loadConfig', () => {
  it('parses valid env and applies defaults', () => {
    const cfg = loadConfig(valid)
    expect(cfg.PORT).toBe(3001)
    expect(cfg.JUMPSELLER_SCOPES).toContain('read_orders')
    expect(cfg.LOYALTYOS_API_URL).toBe('http://localhost:3002')
    expect(cfg.LOYALTYOS_PROGRAM_ID).toBe('prog_dev')
  })

  it('throws when a required var is missing', () => {
    expect(() => loadConfig({ APP_URL: 'https://x.dev' })).toThrow(/Invalid configuration/)
  })

  it('throws when the encryption key is not 64 hex chars', () => {
    expect(() => loadConfig({ ...valid, TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(/Invalid configuration/)
  })
})
