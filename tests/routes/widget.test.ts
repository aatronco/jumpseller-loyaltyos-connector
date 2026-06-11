import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import { prisma } from '../../src/db.js'
import type { LoyaltyOsClient } from '../../src/loyaltyos/client.js'

const STORE = 'store_widget'

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.memberMap.deleteMany({ where: { storeId: STORE } })
})

interface LoyaltyStub {
  getMemberBalance: ReturnType<typeof vi.fn>
  listRewards: ReturnType<typeof vi.fn>
}

function stubLoyalty(confirmed = 120): LoyaltyStub {
  return {
    getMemberBalance: vi.fn().mockResolvedValue({ confirmed, pending: 30, total: confirmed + 30 }),
    listRewards: vi.fn().mockResolvedValue([]),
  }
}

function appWith(loyalty: LoyaltyStub) {
  return buildServer({
    widget: { loyalty: loyalty as unknown as LoyaltyOsClient, appUrl: 'https://conn.dev', portalUrl: 'https://portal.dev' },
  })
}

describe('GET /widget.js', () => {
  it('serves the script with the right content type and baked-in URLs', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: '/widget.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/javascript')
    expect(res.body).toContain('loyaltyos-customer-email')
    expect(res.body).toContain("var API = 'https://conn.dev'")
    expect(res.body).toContain('/widget/rewards')
    expect(res.body).toContain('/widget/redeem')
    await app.close()
  })
})

describe('GET /widget/balance', () => {
  it('returns the confirmed points for a mapped customer', async () => {
    await prisma.memberMap.create({
      data: { storeId: STORE, jumpsellerCustomerId: '42', email: 'ana@x.com', loyaltyMemberId: 'loy_a' },
    })
    const loyalty = stubLoyalty(250)
    const app = appWith(loyalty)
    const res = await app.inject({
      method: 'GET',
      url: `/widget/balance?email=ana%40x.com&store=${STORE}&customerId=42`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ points: 250 })
    expect(loyalty.getMemberBalance).toHaveBeenCalledWith('loy_a')
    await app.close()
  })

  it('returns zero for an unknown customerId without calling LoyaltyOS', async () => {
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const res = await app.inject({
      method: 'GET',
      url: `/widget/balance?email=nadie%40x.com&store=${STORE}&customerId=99`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ points: 0 })
    expect(loyalty.getMemberBalance).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects an invalid email', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({
      method: 'GET',
      url: `/widget/balance?email=notanemail&store=${STORE}&customerId=1`,
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('GET /widget/rewards', () => {
  beforeEach(async () => {
    await prisma.install.deleteMany({ where: { storeId: STORE } })
    await prisma.install.create({
      data: {
        storeId: STORE,
        storeUrl: 'https://store-widget.jumpseller.com',
        scopes: 'read_orders',
        accessToken: 'enc',
        refreshToken: 'enc',
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
    })
  })

  it('lists only active, in-stock rewards with a valid coupon config, sorted by cost', async () => {
    const loyalty = stubLoyalty()
    loyalty.listRewards.mockResolvedValue([
      { id: 'r1', name: 'Cafe', isActive: true, pointsCost: 300, stock: 10, description: '{"couponType":"fixed","couponValue":2000}' },
      { id: 'r2', name: 'Gift', isActive: true, pointsCost: 100, stock: 5, description: '{"couponType":"percent","couponValue":10}' },
      { id: 'r3', name: 'Inactive', isActive: false, pointsCost: 50, stock: 5, description: '{"couponType":"fixed","couponValue":1}' },
      { id: 'r4', name: 'NoStock', isActive: true, pointsCost: 50, stock: 0, description: '{"couponType":"fixed","couponValue":1}' },
      { id: 'r5', name: 'NoCoupon', isActive: true, pointsCost: 50, stock: 5, description: 'just text' },
      { id: 'r6', name: 'NoDesc', isActive: true, pointsCost: 50, stock: 5, description: null },
    ])
    const app = appWith(loyalty)
    const res = await app.inject({ method: 'GET', url: `/widget/rewards?store=${STORE}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      rewards: [
        { id: 'r2', name: 'Gift', pointsCost: 100 },
        { id: 'r1', name: 'Cafe', pointsCost: 300 },
      ],
    })
    await app.close()
  })

  it('404s for a store without an install', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: '/widget/rewards?store=ghost_store' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('400s without a store param', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: '/widget/rewards' })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
