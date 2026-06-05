import Fastify, { type FastifyInstance } from 'fastify'
import { healthRoutes } from './routes/health.js'

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false })
  app.register(healthRoutes)
  return app
}
