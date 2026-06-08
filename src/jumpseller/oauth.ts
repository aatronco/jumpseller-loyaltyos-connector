const ACCOUNTS_BASE = 'https://accounts.jumpseller.com'

export interface OAuthAppConfig {
  appId: string
  appSecret: string
  redirectUri: string
  scopes: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: Date
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  created_at: number
}

function toTokenSet(json: TokenResponse): TokenSet {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date((json.created_at + json.expires_in) * 1000),
  }
}

export function buildAuthorizeUrl(app: OAuthAppConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: app.redirectUri,
    response_type: 'code',
    scope: app.scopes,
    state,
  })
  return `${ACCOUNTS_BASE}/oauth/authorize?${params.toString()}`
}

async function postToken(body: URLSearchParams, fetchFn: typeof fetch): Promise<TokenSet> {
  const res = await fetchFn(`${ACCOUNTS_BASE}/oauth/token`, { method: 'POST', body })
  if (!res.ok) throw new Error(`Jumpseller token request failed: ${res.status}`)
  return toTokenSet((await res.json()) as TokenResponse)
}

export function exchangeCode(app: OAuthAppConfig, code: string, fetchFn: typeof fetch = fetch): Promise<TokenSet> {
  return postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: app.appId,
      client_secret: app.appSecret,
      redirect_uri: app.redirectUri,
    }),
    fetchFn,
  )
}

export function refreshAccessToken(
  app: OAuthAppConfig,
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<TokenSet> {
  return postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: app.appId,
      client_secret: app.appSecret,
    }),
    fetchFn,
  )
}
