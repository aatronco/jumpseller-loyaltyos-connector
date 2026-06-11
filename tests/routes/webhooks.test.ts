import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { buildServer } from '../../src/server.js'
import { prisma } from '../../src/db.js'
import type { LoyaltyOsClient } from '../../src/loyaltyos/client.js'

const SECRET = 'test-hooks-token'
const STORE = 'store_wh'

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.processedWebhook.deleteMany({ where: { storeId: STORE } })
  await prisma.memberMap.deleteMany({ where: { storeId: STORE } })
  await prisma.deadLetter.deleteMany({ where: { storeId: STORE } })
})

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('base64')
}

function orderBody(id = 1026): string {
  return JSON.stringify({
    order: {
      id,
      status: 'Paid',
      currency: 'CLP',
      subtotal: 25990, // merchandise value — what earns points
      total: 29990, // includes shipping; must NOT be used for earning
      customer: { id: 777, email: 'cliente@x.com' },
    },
  })
}

interface LoyaltyStub {
  ensureMember: ReturnType<typeof vi.fn>
  recordPurchase: ReturnType<typeof vi.fn>
}

function stubLoyalty(): LoyaltyStub {
  return {
    ensureMember: vi.fn().mockResolvedValue({ id: 'loy_777' }),
    recordPurchase: vi.fn().mockResolvedValue(undefined),
  }
}

function appWith(loyalty: LoyaltyStub) {
  return buildServer({ webhooks: { webhookSecret: SECRET, loyalty: loyalty as unknown as LoyaltyOsClient } })
}

function inject(app: ReturnType<typeof buildServer>, body: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/jumpseller',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'jumpseller-hmac-sha256': sign(body),
      'jumpseller-event': 'order_paid',
      'jumpseller-store-code': STORE,
      ...headers,
    },
  })
}

describe('POST /webhooks/jumpseller', () => {
  it('rejects an invalid signature without touching LoyaltyOS', async () => {
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const body = orderBody()
    const res = await inject(app, body, { 'jumpseller-hmac-sha256': sign(body, 'wrong-secret') })
    expect(res.statusCode).toBe(401)
    expect(loyalty.ensureMember).not.toHaveBeenCalled()
    await app.close()
  })

  it('ignores events other than order_paid', async () => {
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const res = await inject(app, orderBody(), { 'jumpseller-event': 'order_pending' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ignored: true })
    expect(loyalty.recordPurchase).not.toHaveBeenCalled()
    await app.close()
  })

  it('returns 400 on a signed but malformed payload', async () => {
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const res = await inject(app, JSON.stringify({ nope: true }))
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('processes a valid order_paid: member resolved, purchase recorded, idempotency row written', async () => {
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const res = await inject(app, orderBody(1026))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    expect(loyalty.ensureMember).toHaveBeenCalledWith('cliente@x.com')
    expect(loyalty.ensureMember).toHaveBeenCalledTimes(1)
    expect(loyalty.recordPurchase).toHaveBeenCalledWith({
      memberId: 'loy_777',
      amount: 25990,
      currency: 'CLP',
      orderId: '1026',
      idempotencyKey: `${STORE}:order_paid:1026`,
    })
    expect(loyalty.recordPurchase).toHaveBeenCalledTimes(1)

    const row = await prisma.processedWebhook.findUnique({
      where: { storeId_eventId: { storeId: STORE, eventId: 'order_paid:1026' } },
    })
    expect(row).not.toBeNull()
    await app.close()
  })

  it('treats a re-delivery of the same order as a duplicate (processed once)', async () => {
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const first = await inject(app, orderBody(2000))
    const second = await inject(app, orderBody(2000))
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ duplicate: true })
    expect(loyalty.recordPurchase).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('on LoyaltyOS failure: releases the idempotency lock, dead-letters, returns 500', async () => {
    const loyalty = stubLoyalty()
    loyalty.recordPurchase.mockRejectedValue(new Error('LoyaltyOS POST /api/v1/events failed: 503'))
    const app = appWith(loyalty)
    const res = await inject(app, orderBody(3000))
    expect(res.statusCode).toBe(500)

    const lock = await prisma.processedWebhook.findUnique({
      where: { storeId_eventId: { storeId: STORE, eventId: 'order_paid:3000' } },
    })
    expect(lock).toBeNull() // released so a retry can re-process

    const dead = await prisma.deadLetter.findFirst({ where: { storeId: STORE } })
    expect(dead?.error).toContain('503')
    await app.close()
  })

  it('does not break normal JSON parsing on other routes (parser is scoped)', async () => {
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toEqual({ status: 'ok' })
    await app.close()
  })
})
