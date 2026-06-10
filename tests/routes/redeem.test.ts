import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import { prisma } from '../../src/db.js'
import { saveInstall } from '../../src/installs.js'
import type { LoyaltyOsClient } from '../../src/loyaltyos/client.js'
import type { OAuthAppConfig } from '../../src/jumpseller/oauth.js'

const STORE = 'store_redeem'
const KEY = 'd'.repeat(64)
const oauthApp: OAuthAppConfig = { appId: 'c', appSecret: 's', redirectUri: 'https://x/cb', scopes: 'read_store' }

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.memberMap.deleteMany({ where: { storeId: STORE } })
  await prisma.redemption.deleteMany({ where: { storeId: STORE } })
  await prisma.deadLetter.deleteMany({ where: { storeId: STORE } })
  await prisma.install.deleteMany({ where: { storeId: STORE } })
})

interface LoyaltyStub {
  getReward: ReturnType<typeof vi.fn>
  redeemReward: ReturnType<typeof vi.fn>
}

function stubLoyalty(): LoyaltyStub {
  return {
    getReward: vi.fn().mockResolvedValue({
      id: 'rw1',
      isActive: true,
      pointsCost: 100,
      stock: null,
      metadata: { couponType: 'fixed', couponValue: 5000 },
    }),
    redeemReward: vi.fn().mockResolvedValue({
      redemption: { id: 'red1', rewardId: 'rw1', memberId: 'loy_r', pointsSpent: 100 },
    }),
  }
}

async function seedMemberAndInstall(): Promise<void> {
  await prisma.memberMap.create({
    data: { storeId: STORE, jumpsellerCustomerId: '5', email: 'r@x.com', loyaltyMemberId: 'loy_r' },
  })
  await saveInstall(
    {
      storeId: STORE,
      storeUrl: 'https://s.jumpseller.com',
      scopes: 'write_promotions',
      tokens: { accessToken: 'valid-at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 3_600_000) },
    },
    KEY,
  )
}

function appWith(loyalty: LoyaltyStub, fetchFn: typeof fetch) {
  return buildServer({
    redeem: { loyalty: loyalty as unknown as LoyaltyOsClient, oauthApp, encryptionKey: KEY, fetchFn },
  })
}

function postRedeem(app: ReturnType<typeof buildServer>, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/widget/redeem', payload: body })
}

describe('POST /widget/redeem', () => {
  it('redeems and returns a coupon code (promotion created in Jumpseller)', async () => {
    await seedMemberAndInstall()
    const loyalty = stubLoyalty()
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ promotion: { id: 1 } }), { status: 201 }))
    const app = appWith(loyalty, fetchFn as unknown as typeof fetch)

    const res = await postRedeem(app, { email: 'r@x.com', store: STORE, rewardId: 'rw1' })
    expect(res.statusCode).toBe(200)
    const { code } = res.json() as { code: string }
    expect(code).toMatch(/^LOYAL-[0-9A-F]{8}$/)

    expect(loyalty.redeemReward).toHaveBeenCalledTimes(1)
    // promotions call carried the coupon code
    const promoCall = fetchFn.mock.calls.find((c) => String(c[0]).includes('/promotions.json'))
    expect(promoCall).toBeDefined()
    expect(JSON.parse((promoCall?.[1] as { body: string }).body).promotion.coupons[0].code).toBe(code)

    const row = await prisma.redemption.findFirst({ where: { storeId: STORE } })
    expect(row?.status).toBe('completed')
    expect(row?.couponCode).toBe(code)
    await app.close()
  })

  it('404s for an unmapped customer', async () => {
    const loyalty = stubLoyalty()
    const app = appWith(loyalty, vi.fn() as unknown as typeof fetch)
    const res = await postRedeem(app, { email: 'nadie@x.com', store: STORE, rewardId: 'rw1' })
    expect(res.statusCode).toBe(404)
    expect(loyalty.redeemReward).not.toHaveBeenCalled()
    await app.close()
  })

  it('422s for a reward without coupon metadata', async () => {
    await seedMemberAndInstall()
    const loyalty = stubLoyalty()
    loyalty.getReward.mockResolvedValue({ id: 'rw2', isActive: true, pointsCost: 50, stock: null, metadata: {} })
    const app = appWith(loyalty, vi.fn() as unknown as typeof fetch)
    const res = await postRedeem(app, { email: 'r@x.com', store: STORE, rewardId: 'rw2' })
    expect(res.statusCode).toBe(422)
    expect(loyalty.redeemReward).not.toHaveBeenCalled()
    await app.close()
  })

  it('402s when LoyaltyOS rejects the redemption (insufficient points)', async () => {
    await seedMemberAndInstall()
    const loyalty = stubLoyalty()
    loyalty.redeemReward.mockRejectedValue(new Error('LoyaltyOS POST failed: 422'))
    const app = appWith(loyalty, vi.fn() as unknown as typeof fetch)
    const res = await postRedeem(app, { email: 'r@x.com', store: STORE, rewardId: 'rw1' })
    expect(res.statusCode).toBe(402)
    await app.close()
  })

  it('records failed_coupon + dead letter when the coupon cannot be created', async () => {
    await seedMemberAndInstall()
    const loyalty = stubLoyalty()
    const fetchFn = vi.fn().mockResolvedValue(new Response('err', { status: 500 }))
    const app = appWith(loyalty, fetchFn as unknown as typeof fetch)

    const res = await postRedeem(app, { email: 'r@x.com', store: STORE, rewardId: 'rw1' })
    expect(res.statusCode).toBe(502)

    const row = await prisma.redemption.findFirst({ where: { storeId: STORE } })
    expect(row?.status).toBe('failed_coupon')
    const dead = await prisma.deadLetter.findFirst({ where: { storeId: STORE } })
    expect(dead?.error).toContain('500')
    await app.close()
  })
})
