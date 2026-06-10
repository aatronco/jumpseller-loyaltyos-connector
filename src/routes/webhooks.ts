import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { verifyWebhookSignature } from '../jumpseller/webhook-signature.js'
import { getOrCreateLoyaltyMember } from '../members.js'
import { prisma } from '../db.js'
import type { LoyaltyOsClient } from '../loyaltyos/client.js'

export interface WebhookRoutesDeps {
  webhookSecret: string
  loyalty: LoyaltyOsClient
}

const orderPaidSchema = z.object({
  order: z.object({
    id: z.coerce.number(),
    currency: z.string().min(1),
    total: z.coerce.number(),
    customer: z.object({
      id: z.coerce.string(),
      email: z.string().email(),
    }),
  }),
})

const UNIQUE_VIOLATION = 'P2002'

export async function webhookRoutes(server: FastifyInstance, deps: WebhookRoutesDeps): Promise<void> {
  // Scoped to this plugin: keep the raw bytes so the HMAC is computed over
  // exactly what Jumpseller sent, not a re-serialized object.
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  )

  server.post('/webhooks/jumpseller', async (req, reply) => {
    const rawBody = req.body as Buffer

    // 1) Authenticity first — nothing is parsed before this passes.
    const signature = req.headers['jumpseller-hmac-sha256']
    if (!verifyWebhookSignature(rawBody, typeof signature === 'string' ? signature : undefined, deps.webhookSecret)) {
      return reply.code(401).send({ error: 'invalid_signature' })
    }

    const event = req.headers['jumpseller-event']
    const storeId = req.headers['jumpseller-store-code']
    if (typeof storeId !== 'string' || storeId.length === 0) {
      return reply.code(400).send({ error: 'missing_store_code' })
    }
    if (event !== 'order_paid') {
      return reply.code(200).send({ ignored: true })
    }

    // 2) Parse + validate.
    let parsed: z.infer<typeof orderPaidSchema>
    try {
      parsed = orderPaidSchema.parse(JSON.parse(rawBody.toString('utf8')))
    } catch {
      return reply.code(400).send({ error: 'invalid_payload' })
    }
    const { order } = parsed
    const eventId = `order_paid:${order.id}`

    // 3) Idempotency lock: the unique insert is the gate; a duplicate delivery
    //    (Jumpseller retries) hits the unique constraint and exits early.
    try {
      await prisma.processedWebhook.create({ data: { storeId, eventId } })
    } catch (err) {
      if (err instanceof Object && 'code' in err && err.code === UNIQUE_VIOLATION) {
        return reply.code(200).send({ duplicate: true })
      }
      throw err
    }

    // 4) Process; on failure release the lock, dead-letter, and 500 so
    //    Jumpseller's retry policy re-delivers.
    try {
      const memberId = await getOrCreateLoyaltyMember(
        storeId,
        { id: order.customer.id, email: order.customer.email },
        deps.loyalty,
      )
      await deps.loyalty.recordPurchase({
        memberId,
        amount: order.total,
        currency: order.currency,
        orderId: String(order.id),
        idempotencyKey: `${storeId}:${eventId}`,
      })
    } catch (err) {
      await prisma.processedWebhook.deleteMany({ where: { storeId, eventId } })
      await prisma.deadLetter.create({
        data: {
          storeId,
          payload: rawBody.toString('utf8'),
          error: err instanceof Error ? err.message : String(err),
          attempts: 1,
        },
      })
      return reply.code(500).send({ error: 'processing_failed' })
    }

    return reply.code(200).send({ ok: true })
  })
}
