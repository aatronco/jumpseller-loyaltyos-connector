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

    // Exchange + persist. Failures here mean nothing was installed: surface 502.
    let client: JumpsellerClient
    try {
      const tokens = await exchangeCode(deps.app, code, fetchFn)
      client = new JumpsellerClient(tokens.accessToken, fetchFn)
      const store = await client.getStoreInfo()
      await saveInstall(
        { storeId: store.code, storeUrl: store.url, scopes: deps.app.scopes, tokens },
        deps.encryptionKey,
      )
    } catch (err) {
      req.log.error({ err }, 'oauth install failed')
      return reply.code(502).send({ error: 'install_failed' })
    }

    // The install is persisted; setup failures after this point must not lose
    // it. Surface a notice so the merchant can retry instead of an opaque 500.
    const notices: string[] = []
    try {
      await client.registerHook('order_paid', `${deps.appUrl}/webhooks/jumpseller`)
    } catch (err) {
      req.log.error({ err }, 'webhook registration failed after install')
      notices.push(
        'the order webhook could not be registered automatically. Reinstall the app or register it manually before orders can earn points.',
      )
    }
    try {
      await client.createJsApp(`${deps.appUrl}/widget.js`, 'layout', 'body')
    } catch (err) {
      req.log.error({ err }, 'widget js app creation failed after install')
      notices.push('the storefront widget could not be injected automatically. Reinstall the app to retry.')
    }

    const noticeHtml = notices.map((n) => `<p><strong>Note:</strong> ${n}</p>`).join('')
    return reply
      .type('text/html')
      .send(`<h1>LoyaltyOS connected ✓</h1>${noticeHtml || '<p>You can close this window.</p>'}`)
  })
}
