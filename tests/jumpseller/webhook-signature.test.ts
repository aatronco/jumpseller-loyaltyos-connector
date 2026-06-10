import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyWebhookSignature } from '../../src/jumpseller/webhook-signature.js'

const SECRET = 'hooks-token-123'

function sign(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64')
}

describe('verifyWebhookSignature', () => {
  const body = Buffer.from(JSON.stringify({ order: { id: 1 } }))

  it('accepts a valid signature', () => {
    expect(verifyWebhookSignature(body, sign(body, SECRET), SECRET)).toBe(true)
  })

  it('rejects a signature made with the wrong secret', () => {
    expect(verifyWebhookSignature(body, sign(body, 'other-secret'), SECRET)).toBe(false)
  })

  it('rejects when the body was tampered after signing', () => {
    const sig = sign(body, SECRET)
    const tampered = Buffer.from(JSON.stringify({ order: { id: 999 } }))
    expect(verifyWebhookSignature(tampered, sig, SECRET)).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false)
  })

  it('rejects a different-length header without throwing', () => {
    expect(verifyWebhookSignature(body, 'short', SECRET)).toBe(false)
  })
})
