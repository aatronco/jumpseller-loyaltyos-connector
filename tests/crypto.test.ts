import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from '../src/crypto.js'

const key = 'a'.repeat(64) // 32 bytes hex

describe('crypto', () => {
  it('round-trips a value', () => {
    const enc = encrypt('secret-token', key)
    expect(enc).not.toContain('secret-token')
    expect(decrypt(enc, key)).toBe('secret-token')
  })

  it('produces different ciphertext each call (random IV)', () => {
    expect(encrypt('x', key)).not.toBe(encrypt('x', key))
  })

  it('fails to decrypt if the ciphertext is tampered', () => {
    const enc = encrypt('secret', key)
    const [iv, tag] = enc.split(':')
    const tampered = [iv, tag, Buffer.from('zzzz').toString('base64')].join(':')
    expect(() => decrypt(tampered, key)).toThrow()
  })
})
