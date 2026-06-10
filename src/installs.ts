import { prisma } from './db.js'
import { encrypt, decrypt } from './crypto.js'
import { refreshAccessToken, type OAuthAppConfig, type TokenSet } from './jumpseller/oauth.js'

export interface InstallInput {
  storeId: string
  storeUrl: string
  scopes: string
  tokens: TokenSet
}

const EXPIRY_SKEW_MS = 60_000

// Single-flight guard: concurrent callers during a refresh share one promise,
// so a rotated refresh_token is never consumed twice (Plan-2 review fix).
const refreshInFlight = new Map<string, Promise<string>>()

export async function saveInstall(input: InstallInput, keyHex: string): Promise<void> {
  const data = {
    storeUrl: input.storeUrl,
    scopes: input.scopes,
    accessToken: encrypt(input.tokens.accessToken, keyHex),
    refreshToken: encrypt(input.tokens.refreshToken, keyHex),
    tokenExpiresAt: input.tokens.expiresAt,
  }
  await prisma.install.upsert({
    where: { storeId: input.storeId },
    create: { storeId: input.storeId, ...data },
    update: data,
  })
}

export async function getValidAccessToken(
  storeId: string,
  app: OAuthAppConfig,
  keyHex: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const install = await prisma.install.findUnique({ where: { storeId } })
  if (!install) throw new Error(`No install found for store ${storeId}`)

  if (install.tokenExpiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS) {
    return decrypt(install.accessToken, keyHex)
  }

  const inFlight = refreshInFlight.get(storeId)
  if (inFlight) return inFlight

  const refresh = (async () => {
    const refreshed = await refreshAccessToken(app, decrypt(install.refreshToken, keyHex), fetchFn)
    await prisma.install.update({
      where: { storeId },
      data: {
        accessToken: encrypt(refreshed.accessToken, keyHex),
        refreshToken: encrypt(refreshed.refreshToken, keyHex),
        tokenExpiresAt: refreshed.expiresAt,
      },
    })
    return refreshed.accessToken
  })()

  const wrapped = refresh.finally(() => refreshInFlight.delete(storeId))
  refreshInFlight.set(storeId, wrapped)
  return wrapped
}
