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
}

function stubLoyalty(confirmed = 120): LoyaltyStub {
  return {
    getMemberBalance: vi.fn().mockResolvedValue({ confirmed, pending: 30, total: confirmed + 30 }),
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
    expect(res.body).toContain('https://conn.dev/widget/balance')
    expect(res.body).toContain('https://portal.dev')
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
