import Fastify, { type FastifyInstance } from 'fastify'
import { healthRoutes } from './routes/health.js'
import { oauthRoutes, type OAuthRoutesDeps } from './routes/oauth.js'

export interface ServerOptions {
  oauth?: OAuthRoutesDeps
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false })
  app.register(healthRoutes)
  if (opts.oauth) {
    app.register(oauthRoutes, opts.oauth)
  }
  return app
}
