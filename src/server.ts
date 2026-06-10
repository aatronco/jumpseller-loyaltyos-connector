import Fastify, { type FastifyInstance } from 'fastify'
import { healthRoutes } from './routes/health.js'
import { oauthRoutes, type OAuthRoutesDeps } from './routes/oauth.js'
import { webhookRoutes, type WebhookRoutesDeps } from './routes/webhooks.js'
import { widgetRoutes, type WidgetRoutesDeps } from './routes/widget.js'
import { redeemRoutes, type RedeemRoutesDeps } from './routes/redeem.js'

export interface ServerOptions {
  oauth?: OAuthRoutesDeps
  webhooks?: WebhookRoutesDeps
  widget?: WidgetRoutesDeps
  redeem?: RedeemRoutesDeps
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false })
  app.register(healthRoutes)
  if (opts.oauth) {
    app.register(oauthRoutes, opts.oauth)
  }
  if (opts.webhooks) {
    app.register(webhookRoutes, opts.webhooks)
  }
  if (opts.widget) {
    app.register(widgetRoutes, opts.widget)
  }
  if (opts.redeem) {
    app.register(redeemRoutes, opts.redeem)
  }
  return app
}
