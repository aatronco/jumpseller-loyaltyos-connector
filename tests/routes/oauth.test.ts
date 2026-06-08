import { describe, it, expect, vi, afterAll } from 'vitest'
import { buildServer } from '../../src/server.js'
import { prisma } from '../../src/db.js'
import type { OAuthRoutesDeps } from '../../src/routes/oauth.js'

afterAll(async () => {
  await prisma.$disconnect()
})

function deps(fetchFn: typeof fetch): OAuthRoutesDeps {
  return {
    app: { appId: 'cid', appSecret: 'sec', redirectUri: 'https://x.dev/oauth/callback', scopes: 'read_store' },
    encryptionKey: 'c'.repeat(64),
    appUrl: 'https://x.dev',
    fetchFn,
  }
}

describe('GET /install', () => {
  it('redirects to the Jumpseller authorize endpoint', async () => {
    const app = buildServer({ oauth: deps(vi.fn() as unknown as typeof fetch) })
    const res = await app.inject({ method: 'GET', url: '/install' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('https://accounts.jumpseller.com/oauth/authorize')
    expect(res.headers.location).toContain('client_id=cid')
    await app.close()
  })
})

describe('GET /oauth/callback', () => {
  it('rejects a request with an invalid state', async () => {
    const app = buildServer({ oauth: deps(vi.fn() as unknown as typeof fetch) })
    const res = await app.inject({ method: 'GET', url: '/oauth/callback?code=x&state=bogus' })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('exchanges the code, stores the install, and registers the order_paid hook', async () => {
    const fetchFn = vi
      .fn()
      // 1) token exchange
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, created_at: 1_700_000_000 }),
          { status: 200 },
        ),
      )
      // 2) GET /store/info.json
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ store: { code: 'store_cb', name: 'S', url: 'https://store_cb.jumpseller.com', currency: 'CLP' } }),
          { status: 200 },
        ),
      )
      // 3) POST /hooks.json
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hook: { id: 1, event: 'order_paid', url: 'https://x.dev/webhooks/jumpseller' } }), {
          status: 201,
        }),
      )

    const app = buildServer({ oauth: deps(fetchFn as unknown as typeof fetch) })

    // obtain a valid state by hitting /install first
    const install = await app.inject({ method: 'GET', url: '/install' })
    const state = new URL(install.headers.location as string).searchParams.get('state') as string

    const res = await app.inject({ method: 'GET', url: `/oauth/callback?code=abc&state=${state}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('connected')

    const row = await prisma.install.findUniqueOrThrow({ where: { storeId: 'store_cb' } })
    expect(row.accessToken).not.toBe('at') // encrypted

    // third fetch call registered the order_paid hook
    const hookCall = fetchFn.mock.calls[2]
    expect(hookCall[0]).toBe('https://api.jumpseller.com/v1/hooks.json')
    expect(JSON.parse((hookCall[1] as { body: string }).body)).toEqual({
      hook: { event: 'order_paid', url: 'https://x.dev/webhooks/jumpseller' },
    })

    await prisma.install.delete({ where: { storeId: 'store_cb' } })
    await app.close()
  })
})
