import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { buildAuthorizeUrl, exchangeCode, type OAuthAppConfig } from '../jumpseller/oauth.js'
import { JumpsellerClient } from '../jumpseller/client.js'
import { saveInstall } from '../installs.js'
import { createState, consumeState } from '../oauth-state.js'

export interface OAuthRoutesDeps {
  app: OAuthAppConfig
  encryptionKey: string
  appUrl: string
  fetchFn?: typeof fetch
}

export async function oauthRoutes(server: FastifyInstance, deps: OAuthRoutesDeps): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch

  server.get('/install', async (_req, reply) => {
    const state = randomBytes(16).toString('hex')
    createState(state)
    return reply.redirect(buildAuthorizeUrl(deps.app, state))
  })

  server.get<{ Querystring: { code?: string; state?: string } }>('/oauth/callback', async (req, reply) => {
    const { code, state } = req.query
    if (!code || !state || !consumeState(state)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const tokens = await exchangeCode(deps.app, code, fetchFn)
    const client = new JumpsellerClient(tokens.accessToken, fetchFn)
    const store = await client.getStoreInfo()

    await saveInstall(
      { storeId: store.code, storeUrl: store.url, scopes: deps.app.scopes, tokens },
      deps.encryptionKey,
    )
    await client.registerHook('order_paid', `${deps.appUrl}/webhooks/jumpseller`)

    return reply.type('text/html').send('<h1>LoyaltyOS connected ✓</h1><p>You can close this window.</p>')
  })
}
