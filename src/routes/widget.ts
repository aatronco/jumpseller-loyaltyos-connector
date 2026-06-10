import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { applyWidgetCors } from '../widget-cors.js'
import type { LoyaltyOsClient } from '../loyaltyos/client.js'

export interface WidgetRoutesDeps {
  loyalty: LoyaltyOsClient
  appUrl: string
  portalUrl?: string
}

const balanceQuerySchema = z.object({
  email: z.string().email(),
  store: z.string().min(1),
  customerId: z.string().min(1),
})

// Phase-1, single-process per-IP rate limit for the public balance endpoint.
const RATE_LIMIT = 60
const WINDOW_MS = 60_000
const hits = new Map<string, { count: number; resetAt: number }>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = hits.get(ip)
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return false
  }
  entry.count += 1
  return entry.count > RATE_LIMIT
}

function widgetScript(appUrl: string, portalUrl: string): string {
  return `(function () {
  var meta = document.querySelector('meta[name="loyaltyos-customer-email"]')
  var email = meta && meta.getAttribute('content')
  var idMeta = document.querySelector('meta[name="loyaltyos-customer-id"]')
  var customerId = idMeta && idMeta.getAttribute('content')
  if (!email || !customerId) return
  var store = document.querySelector('meta[name="loyaltyos-store-code"]')
  var storeCode = (store && store.getAttribute('content')) || window.location.hostname.split('.')[0]
  fetch('${appUrl}/widget/balance?email=' + encodeURIComponent(email) + '&store=' + encodeURIComponent(storeCode) + '&customerId=' + encodeURIComponent(customerId))
    .then(function (r) { return r.ok ? r.json() : null })
    .then(function (data) {
      if (!data) return
      var badge = document.createElement('a')
      badge.href = '${portalUrl}'
      badge.target = '_blank'
      badge.rel = 'noopener'
      badge.textContent = '\\u2B50 ' + data.points + ' puntos'
      badge.setAttribute('style', 'position:fixed;bottom:16px;right:16px;z-index:9999;background:#111;color:#fff;padding:10px 14px;border-radius:24px;font:14px/1 sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.25)')
      badge.addEventListener('click', function (ev) {
        if (!data.points) return
        ev.preventDefault()
        var rewardId = window.prompt('Canjear puntos \\u2014 ID de la recompensa:')
        if (!rewardId) return
        fetch('${appUrl}/widget/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, store: storeCode, rewardId: rewardId }),
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) })
          .then(function (res) {
            if (res.ok && res.j.code) window.alert('Tu cup\\u00F3n: ' + res.j.code)
            else window.alert('No se pudo canjear (' + (res.j.error || 'error') + ')')
          })
          .catch(function () { window.alert('No se pudo canjear') })
      })
      document.body.appendChild(badge)
    })
    .catch(function () {})
})()
`
}

export async function widgetRoutes(server: FastifyInstance, deps: WidgetRoutesDeps): Promise<void> {
  server.get('/widget.js', async (_req, reply) => {
    return reply
      .type('application/javascript')
      .header('cache-control', 'public, max-age=300')
      .send(widgetScript(deps.appUrl, deps.portalUrl ?? deps.appUrl))
  })

  server.get<{ Querystring: { email?: string; store?: string; customerId?: string } }>(
    '/widget/balance',
    async (req, reply) => {
      await applyWidgetCors(req, reply)

      if (rateLimited(req.ip)) {
        return reply.code(429).send({ error: 'rate_limited' })
      }

      const parsed = balanceQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      const { email, store, customerId } = parsed.data

      // Identity binding (security review): BOTH the Jumpseller customer id and
      // the email must match the mapping created by a real purchase. Anything
      // else is a flat zero — no membership signal, no PII.
      const mapping = await prisma.memberMap.findUnique({
        where: { storeId_jumpsellerCustomerId: { storeId: store, jumpsellerCustomerId: customerId } },
      })
      if (!mapping || mapping.email.toLowerCase() !== email.toLowerCase()) {
        return reply.send({ points: 0 })
      }

      const balance = await deps.loyalty.getMemberBalance(mapping.loyaltyMemberId)
      return reply.send({ points: balance.confirmed })
    },
  )
}
