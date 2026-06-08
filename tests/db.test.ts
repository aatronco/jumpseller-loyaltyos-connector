import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '../src/db.js'

afterAll(async () => {
  await prisma.$disconnect()
})

describe('Install model', () => {
  it('persists and reads back an install', async () => {
    const storeId = 'store_test_1'
    await prisma.install.create({
      data: {
        storeId,
        storeUrl: 'https://x.jumpseller.com',
        accessToken: 'enc-access',
        refreshToken: 'enc-refresh',
        scopes: 'read_orders,write_promotions',
        tokenExpiresAt: new Date('2026-01-01T00:00:00Z'),
      },
    })

    const found = await prisma.install.findUnique({ where: { storeId } })
    expect(found?.storeUrl).toBe('https://x.jumpseller.com')
    expect(found?.refreshToken).toBe('enc-refresh')

    await prisma.install.delete({ where: { storeId } })
  })
})
