import type { FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from './db.js'

/**
 * Widget endpoints are called cross-origin from storefronts. Instead of `*`,
 * only origins matching an installed store's URL are allowed (security review).
 */
export async function originAllowed(origin: string): Promise<boolean> {
  const installs = await prisma.install.findMany({ select: { storeUrl: true } })
  return installs.some((i) => {
    try {
      return new URL(i.storeUrl).origin === origin
    } catch {
      return false
    }
  })
}

export async function applyWidgetCors(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const origin = req.headers.origin
  if (typeof origin === 'string' && (await originAllowed(origin))) {
    reply.header('access-control-allow-origin', origin)
    reply.header('vary', 'Origin')
  }
}
