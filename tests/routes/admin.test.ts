import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import { prisma } from '../../src/db.js'
import type { LoyaltyOsClient, Reward } from '../../src/loyaltyos/client.js'

const STORE = 'store_admin'
const APP_URL = 'https://conn.test'

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.storeConfig.deleteMany({ where: { storeId: STORE } })
  await prisma.install.deleteMany({ where: { storeId: STORE } })
})

interface AdminStub {
  listAllRewards: ReturnType<typeof vi.fn>
  createReward: ReturnType<typeof vi.fn>
  updateReward: ReturnType<typeof vi.fn>
  deleteReward: ReturnType<typeof vi.fn>
}

function stubLoyalty(rewards: Reward[] = []): AdminStub {
  return {
    listAllRewards: vi.fn().mockResolvedValue(rewards),
    createReward: vi.fn().mockResolvedValue({ id: 'r_new', name: 'Test', isActive: true, pointsCost: 100, stock: 9999, description: '{"couponType":"fixed","couponValue":1000}' }),
    updateReward: vi.fn().mockResolvedValue({ id: 'r1', name: 'Updated', isActive: true, pointsCost: 200, stock: 9999, description: null }),
    deleteReward: vi.fn().mockResolvedValue(undefined),
  }
}

async function seedInstall() {
  await prisma.install.create({
    data: {
      storeId: STORE,
      storeUrl: 'https://store_admin.jumpseller.com',
      accessToken: 'tok',
      refreshToken: 'ref',
      scopes: 'read_orders',
      tokenExpiresAt: new Date(Date.now() + 86400_000),
    },
  })
}

function appWith(loyalty: AdminStub) {
  return buildServer({ admin: { loyalty: loyalty as unknown as LoyaltyOsClient, appUrl: APP_URL } })
}

describe('GET /', () => {
  it('returns 200 with text/html', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    await app.close()
  })
})

describe('GET /admin/config', () => {
  it('returns 400 when store param is missing', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: '/admin/config' })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('returns 404 for an unknown store', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: '/admin/config?store=unknown_store' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns default conversion rate for a new store', async () => {
    await seedInstall()
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: `/admin/config?store=${STORE}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ conversionRate: 1000 })
    await app.close()
  })
})

describe('PATCH /admin/config', () => {
  it('updates the conversion rate and returns new value', async () => {
    await seedInstall()
    const app = appWith(stubLoyalty())
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/config?store=${STORE}`,
      payload: { conversionRate: 500 },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ conversionRate: 500 })

    const row = await prisma.storeConfig.findUnique({ where: { storeId: STORE } })
    expect(row?.conversionRate).toBe(500)
    await app.close()
  })

  it('rejects a non-positive conversion rate', async () => {
    await seedInstall()
    const app = appWith(stubLoyalty())
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/config?store=${STORE}`,
      payload: { conversionRate: 0 },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('GET /admin/rewards', () => {
  it('returns 404 for unknown store', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: '/admin/rewards?store=nope' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns the rewards list from LoyaltyOS', async () => {
    await seedInstall()
    const rewards: Reward[] = [
      { id: 'r1', name: 'Café gratis', isActive: true, pointsCost: 300, stock: 9999, description: '{"couponType":"fixed","couponValue":500}' },
    ]
    const loyalty = stubLoyalty(rewards)
    const app = appWith(loyalty)
    const res = await app.inject({ method: 'GET', url: `/admin/rewards?store=${STORE}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(rewards)
    expect(loyalty.listAllRewards).toHaveBeenCalledTimes(1)
    await app.close()
  })
})

describe('POST /admin/rewards', () => {
  it('creates a reward in LoyaltyOS and returns it', async () => {
    await seedInstall()
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const res = await app.inject({
      method: 'POST',
      url: `/admin/rewards?store=${STORE}`,
      payload: { name: 'Test', couponValue: 1000, pointsCost: 100 },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(201)
    expect(loyalty.createReward).toHaveBeenCalledWith({
      name: 'Test',
      description: JSON.stringify({ couponType: 'fixed', couponValue: 1000 }),
      pointsCost: 100,
      stock: 9999,
    })
    await app.close()
  })
})

describe('PATCH /admin/rewards/:id', () => {
  it('updates name and pointsCost in LoyaltyOS', async () => {
    await seedInstall()
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/rewards/r1?store=${STORE}`,
      payload: { name: 'New name', pointsCost: 200 },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(loyalty.updateReward).toHaveBeenCalledWith('r1', expect.objectContaining({ name: 'New name', pointsCost: 200 }))
    await app.close()
  })
})

describe('DELETE /admin/rewards/:id', () => {
  it('removes the reward from LoyaltyOS', async () => {
    await seedInstall()
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/rewards/r1?store=${STORE}`,
    })
    expect(res.statusCode).toBe(204)
    expect(loyalty.deleteReward).toHaveBeenCalledWith('r1')
    await app.close()
  })
})
