import { prisma } from './db.js'
import type { LoyaltyOsClient } from './loyaltyos/client.js'

export interface JumpsellerCustomerRef {
  id: string
  email: string
}

/**
 * Resolves a Jumpseller customer to a LoyaltyOS member id, caching the mapping
 * per store in MemberMap. Members are created lazily on first sight (by email).
 */
export async function getOrCreateLoyaltyMember(
  storeId: string,
  customer: JumpsellerCustomerRef,
  loyalty: LoyaltyOsClient,
): Promise<string> {
  const cached = await prisma.memberMap.findUnique({
    where: { storeId_jumpsellerCustomerId: { storeId, jumpsellerCustomerId: customer.id } },
  })
  if (cached) return cached.loyaltyMemberId

  const member = await loyalty.ensureMember(customer.email)
  await prisma.memberMap.upsert({
    where: { storeId_jumpsellerCustomerId: { storeId, jumpsellerCustomerId: customer.id } },
    create: {
      storeId,
      jumpsellerCustomerId: customer.id,
      email: customer.email,
      loyaltyMemberId: member.id,
    },
    update: { email: customer.email, loyaltyMemberId: member.id },
  })
  return member.id
}
