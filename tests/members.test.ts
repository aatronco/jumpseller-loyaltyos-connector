import { describe, it, expect, vi, afterAll } from 'vitest'
import { getOrCreateLoyaltyMember } from '../src/members.js'
import { prisma } from '../src/db.js'
import type { LoyaltyOsClient } from '../src/loyaltyos/client.js'

afterAll(async () => {
  await prisma.$disconnect()
})

function stubLoyalty(memberId: string) {
  return { ensureMember: vi.fn().mockResolvedValue({ id: memberId }) } as unknown as LoyaltyOsClient
}

describe('getOrCreateLoyaltyMember', () => {
  it('creates the mapping on first sight and returns the LoyaltyOS member id', async () => {
    const storeId = 'store_map_1'
    const loyalty = stubLoyalty('loy_1')

    const id = await getOrCreateLoyaltyMember(storeId, { id: '777', email: 'c@x.com' }, loyalty)
    expect(id).toBe('loy_1')
    expect(loyalty.ensureMember).toHaveBeenCalledWith('c@x.com')
    expect(loyalty.ensureMember).toHaveBeenCalledTimes(1)

    const row = await prisma.memberMap.findUniqueOrThrow({
      where: { storeId_jumpsellerCustomerId: { storeId, jumpsellerCustomerId: '777' } },
    })
    expect(row.loyaltyMemberId).toBe('loy_1')

    await prisma.memberMap.deleteMany({ where: { storeId } })
  })

  it('returns the cached mapping without calling LoyaltyOS', async () => {
    const storeId = 'store_map_2'
    await prisma.memberMap.create({
      data: { storeId, jumpsellerCustomerId: '888', email: 'd@x.com', loyaltyMemberId: 'loy_cached' },
    })

    const loyalty = stubLoyalty('should-not-be-used')
    const id = await getOrCreateLoyaltyMember(storeId, { id: '888', email: 'd@x.com' }, loyalty)
    expect(id).toBe('loy_cached')
    expect(loyalty.ensureMember).not.toHaveBeenCalled()

    await prisma.memberMap.deleteMany({ where: { storeId } })
  })
})
