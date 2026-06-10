import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifies a Jumpseller webhook signature: base64(HMAC-SHA256(rawBody, secret)).
 * Compares timing-safe; a length mismatch or missing header returns false (never throws).
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  let provided: Buffer
  try {
    provided = Buffer.from(signatureHeader, 'base64')
  } catch {
    return false
  }
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}
