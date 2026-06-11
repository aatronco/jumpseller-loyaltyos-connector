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

const couponConfigSchema = z.object({
  couponType: z.enum(['fixed', 'percent']),
  couponValue: z.number().positive(),
})

// Phase-1, single-process per-IP rate limit for the public widget endpoints.
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

function widgetScript(appUrl: string): string {
  return `(function () {
  var meta = document.querySelector('meta[name="loyaltyos-customer-email"]')
  var email = meta && meta.getAttribute('content')
  var idMeta = document.querySelector('meta[name="loyaltyos-customer-id"]')
  var customerId = idMeta && idMeta.getAttribute('content')
  if (!email || !customerId) return
  var store = document.querySelector('meta[name="loyaltyos-store-code"]')
  var storeCode = (store && store.getAttribute('content')) || window.location.hostname.split('.')[0]
  var API = '${appUrl}'
  var points = 0
  var panel = null

  function el(tag, style, text) {
    var e = document.createElement(tag)
    if (style) e.setAttribute('style', style)
    if (text) e.textContent = text
    return e
  }

  function closePanel() {
    if (panel) { panel.remove(); panel = null }
  }

  function renderCoupon(body, code) {
    body.innerHTML = ''
    var box = el('div', 'text-align:center;padding:18px 8px')
    box.appendChild(el('div', 'font-size:28px;margin-bottom:6px', '\\uD83C\\uDF89'))
    box.appendChild(el('div', 'font:13px/1.4 sans-serif;color:#555;margin-bottom:10px', 'Tu cup\\u00F3n de descuento:'))
    var codeEl = el('div', 'font:bold 18px/1 monospace;background:#f4f4f4;border:1px dashed #aaa;border-radius:8px;padding:12px;letter-spacing:1px;user-select:all', code)
    box.appendChild(codeEl)
    box.appendChild(el('div', 'font:12px/1.4 sans-serif;color:#777;margin-top:10px', 'C\\u00F3pialo y \\u00FAsalo en el checkout. Es de un solo uso.'))
    body.appendChild(box)
  }

  function renderRewards(body, badge) {
    body.innerHTML = ''
    body.appendChild(el('div', 'font:12px/1 sans-serif;color:#999;padding:10px;text-align:center', 'Cargando recompensas\\u2026'))
    fetch(API + '/widget/rewards?store=' + encodeURIComponent(storeCode))
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (data) {
        body.innerHTML = ''
        if (!data || !data.rewards || !data.rewards.length) {
          body.appendChild(el('div', 'font:13px/1.4 sans-serif;color:#777;padding:14px;text-align:center', 'No hay recompensas disponibles por ahora.'))
          return
        }
        data.rewards.forEach(function (rw) {
          var row = el('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 6px;border-bottom:1px solid #eee')
          var info = el('div', '')
          info.appendChild(el('div', 'font:600 13px/1.3 sans-serif;color:#111', rw.name))
          info.appendChild(el('div', 'font:12px/1.3 sans-serif;color:#888', rw.pointsCost.toLocaleString('es-CL') + ' puntos'))
          row.appendChild(info)
          var afford = points >= rw.pointsCost
          var btn = el('button', 'font:600 12px/1 sans-serif;padding:8px 12px;border-radius:16px;border:none;cursor:pointer;white-space:nowrap;' + (afford ? 'background:#111;color:#fff' : 'background:#eee;color:#aaa;cursor:not-allowed'), 'Canjear')
          if (afford) {
            btn.addEventListener('click', function () {
              btn.disabled = true
              btn.textContent = 'Canjeando\\u2026'
              fetch(API + '/widget/redeem', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email, store: storeCode, customerId: customerId, rewardId: rw.id }),
              })
                .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) })
                .then(function (res) {
                  if (res.ok && res.j.code) {
                    points -= rw.pointsCost
                    badge.textContent = '\\u2B50 ' + points.toLocaleString('es-CL') + ' puntos'
                    renderCoupon(body, res.j.code)
                  } else {
                    btn.disabled = false
                    btn.textContent = 'Canjear'
                    window.alert('No se pudo canjear (' + ((res.j && res.j.error) || 'error') + ')')
                  }
                })
                .catch(function () {
                  btn.disabled = false
                  btn.textContent = 'Canjear'
                  window.alert('No se pudo canjear')
                })
            })
          }
          row.appendChild(btn)
          body.appendChild(row)
        })
      })
      .catch(function () {
        body.innerHTML = ''
        body.appendChild(el('div', 'font:13px/1.4 sans-serif;color:#c00;padding:14px;text-align:center', 'Error cargando recompensas.'))
      })
  }

  function openPanel(badge) {
    if (panel) { closePanel(); return }
    panel = el('div', 'position:fixed;bottom:64px;right:16px;z-index:10000;width:300px;max-height:380px;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.25);padding:14px')
    var head = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px')
    head.appendChild(el('div', 'font:700 14px/1 sans-serif;color:#111', 'Tus recompensas'))
    var close = el('button', 'border:none;background:none;font-size:18px;cursor:pointer;color:#888', '\\u00D7')
    close.addEventListener('click', closePanel)
    head.appendChild(close)
    panel.appendChild(head)
    panel.appendChild(el('div', 'font:12px/1 sans-serif;color:#888;margin-bottom:6px', 'Tienes ' + points.toLocaleString('es-CL') + ' puntos'))
    var body = el('div', '')
    panel.appendChild(body)
    document.body.appendChild(panel)
    renderRewards(body, badge)
  }

  fetch(API + '/widget/balance?email=' + encodeURIComponent(email) + '&store=' + encodeURIComponent(storeCode) + '&customerId=' + encodeURIComponent(customerId))
    .then(function (r) { return r.ok ? r.json() : null })
    .then(function (data) {
      if (!data) return
      points = data.points
      var badge = el('a', 'position:fixed;bottom:16px;right:16px;z-index:9999;background:#111;color:#fff;padding:10px 14px;border-radius:24px;font:14px/1 sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer')
      badge.textContent = '\\u2B50 ' + points.toLocaleString('es-CL') + ' puntos'
      badge.addEventListener('click', function (ev) {
        ev.preventDefault()
        openPanel(badge)
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
      .send(widgetScript(deps.appUrl))
  })

  // Public list of redeemable rewards: active, in stock, and with a valid
  // coupon config (JSON in the description). Only safe fields are exposed.
  server.get<{ Querystring: { store?: string } }>('/widget/rewards', async (req, reply) => {
    await applyWidgetCors(req, reply)

    if (rateLimited(req.ip)) {
      return reply.code(429).send({ error: 'rate_limited' })
    }
    const store = req.query.store
    if (!store) {
      return reply.code(400).send({ error: 'invalid_request' })
    }
    const install = await prisma.install.findUnique({ where: { storeId: store } })
    if (!install) {
      return reply.code(404).send({ error: 'unknown_store' })
    }

    const all = await deps.loyalty.listRewards()
    const rewards = all
      .filter((r) => {
        if (!r.isActive || (r.stock !== null && r.stock !== undefined && r.stock <= 0)) return false
        if (!r.description) return false
        try {
          return couponConfigSchema.safeParse(JSON.parse(r.description)).success
        } catch {
          return false
        }
      })
      .map((r) => ({ id: r.id, name: r.name ?? 'Recompensa', pointsCost: r.pointsCost }))
      .sort((a, b) => a.pointsCost - b.pointsCost)

    return reply.header('cache-control', 'public, max-age=60').send({ rewards })
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
