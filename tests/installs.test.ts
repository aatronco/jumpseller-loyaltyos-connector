import { describe, it, expect, vi, afterAll } from 'vitest'
import { saveInstall, getValidAccessToken } from '../src/installs.js'
import { prisma } from '../src/db.js'
import type { OAuthAppConfig } from '../src/jumpseller/oauth.js'

const KEY = 'b'.repeat(64)
const app: OAuthAppConfig = { appId: 'c', appSecret: 's', redirectUri: 'https://x/cb', scopes: 'read_store' }

afterAll(async () => {
  await prisma.$disconnect()
})

function tokenResponse(at: string, rt: string) {
  return new Response(
    JSON.stringify({ access_token: at, refresh_token: rt, expires_in: 3600, created_at: 1_700_000_000 }),
    { status: 200 },
  )
}

describe('saveInstall + getValidAccessToken', () => {
  it('stores tokens encrypted (not plaintext) and returns the access token when valid', async () => {
    const storeId = 'store_inst_valid'
    const future = new Date(Date.now() + 3_600_000)
    await saveInstall({ storeId, storeUrl: 'https://s.jumpseller.com', scopes: 'read_store', tokens: { accessToken: 'plain-at', refreshToken: 'plain-rt', expiresAt: future } }, KEY)

    const row = await prisma.install.findUniqueOrThrow({ where: { storeId } })
    expect(row.accessToken).not.toBe('plain-at') // encrypted at rest

    const fetchFn = vi.fn() // must NOT be called when token is still valid
    const token = await getValidAccessToken(storeId, app, KEY, fetchFn as unknown as typeof fetch)
    expect(token).toBe('plain-at')
    expect(fetchFn).not.toHaveBeenCalled()

    await prisma.install.delete({ where: { storeId } })
  })

  it('refreshes and persists new tokens when the stored token is expired', async () => {
    const storeId = 'store_inst_expired'
    const past = new Date(Date.now() - 1000)
    await saveInstall({ storeId, storeUrl: 'https://s.jumpseller.com', scopes: 'read_store', tokens: { accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: past } }, KEY)

    const fetchFn = vi.fn().mockResolvedValue(tokenResponse('new-at', 'new-rt'))
    const before = Date.now()
    const token = await getValidAccessToken(storeId, app, KEY, fetchFn as unknown as typeof fetch)
    expect(token).toBe('new-at')
    expect(fetchFn).toHaveBeenCalledOnce()

    const row = await prisma.install.findUniqueOrThrow({ where: { storeId } })
    // expiry is now computed from receipt time + expires_in (3600s)
    expect(row.tokenExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(row.tokenExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3600 * 1000)

    await prisma.install.delete({ where: { storeId } })
  })

  it('single-flights concurrent refreshes (rotated refresh token consumed once)', async () => {
    const storeId = 'store_inst_race'
    const past = new Date(Date.now() - 1000)
    await saveInstall(
      {
        storeId,
        storeUrl: 'https://s.jumpseller.com',
        scopes: 'read_store',
        tokens: { accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: past },
      },
      KEY,
    )

    const fetchFn = vi.fn().mockResolvedValue(tokenResponse('race-at', 'race-rt'))
    const [a, b] = await Promise.all([
      getValidAccessToken(storeId, app, KEY, fetchFn as unknown as typeof fetch),
      getValidAccessToken(storeId, app, KEY, fetchFn as unknown as typeof fetch),
    ])
    expect(a).toBe('race-at')
    expect(b).toBe('race-at')
    expect(fetchFn).toHaveBeenCalledTimes(1) // one refresh for both callers

    await prisma.install.delete({ where: { storeId } })
  })
})
