import type { FastifyInstance } from 'fastify'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getValidAccessToken } from '../installs.js'
import { JumpsellerClient } from '../jumpseller/client.js'
import type { OAuthAppConfig } from '../jumpseller/oauth.js'
import type { LoyaltyOsClient } from '../loyaltyos/client.js'

export interface RedeemRoutesDeps {
  loyalty: LoyaltyOsClient
  oauthApp: OAuthAppConfig
  encryptionKey: string
  fetchFn?: typeof fetch
}

const redeemBodySchema = z.object({
  email: z.string().email(),
  store: z.string().min(1),
  rewardId: z.string().min(1),
})

const couponMetadataSchema = z.object({
  couponType: z.enum(['fixed', 'percent']),
  couponValue: z.number().positive(),
})

// Phase-1, single-process per-IP rate limit (redemptions are expensive).
const RATE_LIMIT = 10
const WINDOW_MS = 60_000
const hits = new Map<string, { count: number; resetAt: number }>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = hits.get(ip)
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return false
  }
  entry.count += 1
  return entry.count > RATE_LIMIT
}

function couponCode(): string {
  return `LOYAL-${randomBytes(4).toString('hex').toUpperCase()}`
}

export async function redeemRoutes(server: FastifyInstance, deps: RedeemRoutesDeps): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch

  server.post('/widget/redeem', async (req, reply) => {
    reply.header('access-control-allow-origin', '*')

    if (rateLimited(req.ip)) {
      return reply.code(429).send({ error: 'rate_limited' })
    }

    const parsed = redeemBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' })
    }
    const { email, store, rewardId } = parsed.data

    const mapping = await prisma.memberMap.findFirst({ where: { storeId: store, email } })
    if (!mapping) {
      return reply.code(404).send({ error: 'unknown_member' })
    }

    // The reward's metadata declares the coupon it maps to; anything else is unsupported.
    const reward = await deps.loyalty.getReward(rewardId)
    const coupon = couponMetadataSchema.safeParse(reward.metadata ?? {})
    if (!coupon.success) {
      return reply.code(422).send({ error: 'unsupported_reward' })
    }

    // Spend the points first; LoyaltyOS enforces balance/stock/tier rules.
    try {
      await deps.loyalty.redeemReward({
        rewardId,
        memberId: mapping.loyaltyMemberId,
        idempotencyKey: `${store}:redeem:${mapping.loyaltyMemberId}:${rewardId}:${randomUUID()}`,
      })
    } catch (err) {
      req.log.warn({ err }, 'loyaltyos redeem rejected')
      return reply.code(402).send({ error: 'insufficient_points' })
    }

    // Points are spent; mint the coupon. A failure here is recorded for manual
    // remediation (Phase 2: automatic reversal).
    const code = couponCode()
    try {
      const accessToken = await getValidAccessToken(store, deps.oauthApp, deps.encryptionKey, fetchFn)
      const client = new JumpsellerClient(accessToken, fetchFn)
      await client.createDiscountCoupon({ code, type: coupon.data.couponType, value: coupon.data.couponValue })
    } catch (err) {
      req.log.error({ err }, 'coupon creation failed after redeem')
      await prisma.redemption.create({
        data: { storeId: store, memberId: mapping.loyaltyMemberId, rewardId, couponCode: code, status: 'failed_coupon' },
      })
      await prisma.deadLetter.create({
        data: {
          storeId: store,
          payload: JSON.stringify({ kind: 'redeem', email, rewardId, code }),
          error: err instanceof Error ? err.message : String(err),
          attempts: 1,
        },
      })
      return reply.code(502).send({ error: 'coupon_failed' })
    }

    await prisma.redemption.create({
      data: { storeId: store, memberId: mapping.loyaltyMemberId, rewardId, couponCode: code, status: 'completed' },
    })
    return reply.send({ code })
  })
}
