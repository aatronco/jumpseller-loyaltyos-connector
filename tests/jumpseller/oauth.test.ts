import { describe, it, expect, vi } from 'vitest'
import { buildAuthorizeUrl, exchangeCode, refreshAccessToken, type OAuthAppConfig } from '../../src/jumpseller/oauth.js'

const app: OAuthAppConfig = {
  appId: 'cid',
  appSecret: 'csecret',
  redirectUri: 'https://x.dev/oauth/callback',
  scopes: 'read_orders read_store',
}

function tokenResponse() {
  return new Response(
    JSON.stringify({
      access_token: 'at',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: 'rt',
      created_at: 1_700_000_000,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('buildAuthorizeUrl', () => {
  it('includes client_id, redirect_uri, response_type, scope, state', () => {
    const url = new URL(buildAuthorizeUrl(app, 'st8'))
    expect(url.origin + url.pathname).toBe('https://accounts.jumpseller.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://x.dev/oauth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('read_orders read_store')
    expect(url.searchParams.get('state')).toBe('st8')
  })
})

describe('exchangeCode', () => {
  it('posts the code and returns a TokenSet with computed expiry', async () => {
    const fetchFn = vi.fn().mockResolvedValue(tokenResponse())
    const before = Date.now()
    const tokens = await exchangeCode(app, 'the-code', fetchFn as unknown as typeof fetch)
    const after = Date.now()
    expect(fetchFn).toHaveBeenCalledWith('https://accounts.jumpseller.com/oauth/token', expect.objectContaining({ method: 'POST' }))
    const body = (fetchFn.mock.calls[0][1] as { body: URLSearchParams }).body
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('client_secret')).toBe('csecret')
    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
    // expiry is computed from receipt time + expires_in (3600s), not the server created_at
    expect(tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(tokens.expiresAt.getTime()).toBeLessThanOrEqual(after + 3600 * 1000)
  })

  it('throws on non-200', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }))
    await expect(exchangeCode(app, 'c', fetchFn as unknown as typeof fetch)).rejects.toThrow(/401/)
  })
})

describe('refreshAccessToken', () => {
  it('posts grant_type=refresh_token', async () => {
    const fetchFn = vi.fn().mockResolvedValue(tokenResponse())
    await refreshAccessToken(app, 'old-rt', fetchFn as unknown as typeof fetch)
    const body = (fetchFn.mock.calls[0][1] as { body: URLSearchParams }).body
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-rt')
  })
})
