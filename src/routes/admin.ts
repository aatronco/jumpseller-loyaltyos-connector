import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import type { LoyaltyOsClient } from '../loyaltyos/client.js'

export interface AdminRoutesDeps {
  loyalty: LoyaltyOsClient
  appUrl: string
}

const DEFAULT_CONVERSION_RATE = 1000
const REWARD_STOCK = 9999

// Returns the storeId when the install exists; otherwise sends the error
// response and returns null so handlers can early-return.
async function requireInstall(store: string | undefined, reply: FastifyReply): Promise<string | null> {
  if (!store) {
    await reply.code(400).send({ error: 'missing_store' })
    return null
  }
  const install = await prisma.install.findUnique({ where: { storeId: store } })
  if (!install) {
    await reply.code(404).send({ error: 'store_not_found' })
    return null
  }
  return store
}

const storeQuerySchema = z.object({ store: z.string().min(1).optional() })
const configBodySchema = z.object({ conversionRate: z.number().positive() })
const rewardBodySchema = z.object({
  name: z.string().min(1),
  couponValue: z.number().positive(),
  pointsCost: z.number().int().positive(),
})
const rewardPatchSchema = rewardBodySchema.partial()
const rewardParamsSchema = z.object({ id: z.string().min(1) })

function adminHtml(appUrl: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoyaltyOS — Configuración</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; padding: 24px; max-width: 640px; color: #111; }
    h1 { font-size: 1.1rem; font-weight: 600; margin-bottom: 24px; }
    section { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    section h2 { font-size: 0.9rem; font-weight: 600; margin-bottom: 12px; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    label { font-size: 0.85rem; color: #555; }
    input[type=number], input[type=text] { border: 1px solid #ccc; border-radius: 4px; padding: 6px 10px; font-size: 0.9rem; width: 120px; }
    input[type=text] { width: 200px; }
    button { padding: 6px 14px; border-radius: 4px; border: 1px solid #ccc; font-size: 0.85rem; cursor: pointer; background: #fff; }
    button.primary { background: #111; color: #fff; border-color: #111; }
    button.danger { color: #c00; border-color: #c00; }
    .error { color: #c00; font-size: 0.8rem; margin-top: 4px; }
    .rewards-list { margin: 12px 0; }
    .reward-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
    .reward-row:last-child { border-bottom: none; }
    .reward-info { font-size: 0.85rem; }
    .reward-actions { display: flex; gap: 6px; }
    .inline-form { margin-top: 16px; padding-top: 16px; border-top: 1px solid #eee; }
    .inline-form .field { margin-bottom: 10px; }
    .inline-form label { display: block; font-size: 0.8rem; margin-bottom: 4px; }
    .inline-form .actions { display: flex; gap: 8px; margin-top: 12px; }
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  </style>
</head>
<body>
<h1>LoyaltyOS — Configuración</h1>

<section id="config-section">
  <h2>Tasa de conversión</h2>
  <div class="row">
    <label>1 punto por cada</label>
    <input type="number" id="conversion-rate" min="1" step="1" value="1000">
    <label>CLP</label>
    <button class="primary" id="save-rate">Guardar</button>
  </div>
  <div class="error" id="config-error"></div>
</section>

<section id="rewards-section">
  <div class="section-header">
    <h2>Recompensas</h2>
    <button class="primary" id="new-reward">+ Nueva</button>
  </div>
  <div class="rewards-list" id="rewards-list"></div>
  <div class="inline-form" id="reward-form" style="display:none">
    <div class="field">
      <label>Título</label>
      <input type="text" id="f-name" placeholder="Ej: Café gratis">
      <div class="error" id="f-name-error"></div>
    </div>
    <div class="field">
      <label>Descuento ($)</label>
      <input type="number" id="f-value" min="1" step="1" placeholder="Ej: 2000">
      <div class="error" id="f-value-error"></div>
    </div>
    <div class="field">
      <label>Costo (pts)</label>
      <input type="number" id="f-cost" min="1" step="1" placeholder="Ej: 300">
      <div class="error" id="f-cost-error"></div>
    </div>
    <div class="actions">
      <button id="cancel-form">Cancelar</button>
      <button class="primary" id="submit-form">Guardar</button>
    </div>
    <div class="error" id="form-error"></div>
  </div>
</section>

<script>
(function () {
  var API = '${appUrl}'
  var params = new URLSearchParams(window.location.search)
  var store = params.get('store') || ''
  var editingId = null
  var rewardsCache = []

  function qs(id) { return document.getElementById(id) }
  function clearErrors() {
    ;['config-error', 'f-name-error', 'f-value-error', 'f-cost-error', 'form-error'].forEach(function (id) {
      var el = qs(id)
      if (el) el.textContent = ''
    })
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function load() {
    Promise.all([
      fetch(API + '/admin/config?store=' + encodeURIComponent(store)).then(function (r) { return r.json() }),
      fetch(API + '/admin/rewards?store=' + encodeURIComponent(store)).then(function (r) { return r.json() }),
    ]).then(function (results) {
      qs('conversion-rate').value = results[0].conversionRate || 1000
      rewardsCache = Array.isArray(results[1]) ? results[1] : []
      renderRewards()
    }).catch(function () {
      qs('config-error').textContent = 'Error cargando configuración.'
    })
  }

  function renderRewards() {
    var list = qs('rewards-list')
    if (rewardsCache.length === 0) {
      list.innerHTML = '<p style="font-size:0.85rem;color:#888">Sin recompensas. Crea una con + Nueva.</p>'
      return
    }
    list.innerHTML = ''
    rewardsCache.forEach(function (r) {
      var desc = {}
      try { desc = JSON.parse(r.description || '{}') } catch (e) { /* ignore */ }
      var row = document.createElement('div')
      row.className = 'reward-row'
      var info = document.createElement('div')
      info.className = 'reward-info'
      info.innerHTML = '<strong>' + escHtml(r.name || '') + '</strong> ' +
        (desc.couponValue ? '$' + escHtml(desc.couponValue) + ' ' : '') + '&mdash; ' + escHtml(r.pointsCost) + ' pts'
      var actions = document.createElement('div')
      actions.className = 'reward-actions'
      var editBtn = document.createElement('button')
      editBtn.textContent = '✎'
      editBtn.addEventListener('click', function () { showEditForm(r) })
      var delBtn = document.createElement('button')
      delBtn.className = 'danger'
      delBtn.textContent = '✕'
      delBtn.addEventListener('click', function () { removeReward(r.id) })
      actions.appendChild(editBtn)
      actions.appendChild(delBtn)
      row.appendChild(info)
      row.appendChild(actions)
      list.appendChild(row)
    })
  }

  function showNewForm() {
    editingId = null
    qs('f-name').value = ''
    qs('f-value').value = ''
    qs('f-cost').value = ''
    clearErrors()
    qs('reward-form').style.display = 'block'
  }

  function showEditForm(r) {
    editingId = r.id
    qs('f-name').value = r.name || ''
    var desc = {}
    try { desc = JSON.parse(r.description || '{}') } catch (e) { /* ignore */ }
    qs('f-value').value = desc.couponValue || ''
    qs('f-cost').value = r.pointsCost || ''
    clearErrors()
    qs('reward-form').style.display = 'block'
  }

  function cancelForm() {
    qs('reward-form').style.display = 'none'
    editingId = null
  }

  function submitRewardForm() {
    clearErrors()
    var name = qs('f-name').value.trim()
    var val = parseInt(qs('f-value').value, 10)
    var cost = parseInt(qs('f-cost').value, 10)
    var ok = true
    if (!name) { qs('f-name-error').textContent = 'Requerido'; ok = false }
    if (!val || val < 1) { qs('f-value-error').textContent = 'Ingresa un monto'; ok = false }
    if (!cost || cost < 1) { qs('f-cost-error').textContent = 'Ingresa un costo'; ok = false }
    if (!ok) return

    var url = API + '/admin/rewards' + (editingId ? '/' + encodeURIComponent(editingId) : '') + '?store=' + encodeURIComponent(store)
    fetch(url, {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, couponValue: val, pointsCost: cost }),
    }).then(function (r) {
      if (!r.ok) throw new Error()
      return r.json()
    }).then(function () {
      cancelForm()
      load()
    }).catch(function () {
      qs('form-error').textContent = 'Error guardando recompensa.'
    })
  }

  function removeReward(id) {
    fetch(API + '/admin/rewards/' + encodeURIComponent(id) + '?store=' + encodeURIComponent(store), { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok && r.status !== 204) throw new Error()
        load()
      })
      .catch(function () {
        qs('form-error').textContent = 'Error eliminando recompensa.'
      })
  }

  function saveConversionRate() {
    clearErrors()
    var rate = parseFloat(qs('conversion-rate').value)
    if (!rate || rate < 1) { qs('config-error').textContent = 'Ingresa un valor válido.'; return }
    fetch(API + '/admin/config?store=' + encodeURIComponent(store), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversionRate: rate }),
    }).then(function (r) {
      if (!r.ok) throw new Error()
      return r.json()
    }).then(function (data) {
      qs('conversion-rate').value = data.conversionRate
    }).catch(function () {
      qs('config-error').textContent = 'Error guardando tasa.'
    })
  }

  qs('save-rate').addEventListener('click', saveConversionRate)
  qs('new-reward').addEventListener('click', showNewForm)
  qs('cancel-form').addEventListener('click', cancelForm)
  qs('submit-form').addEventListener('click', submitRewardForm)

  load()
})()
</script>
</body>
</html>`
}

export async function adminRoutes(server: FastifyInstance, deps: AdminRoutesDeps): Promise<void> {
  server.get('/', async (_req, reply) => {
    return reply.type('text/html').send(adminHtml(deps.appUrl))
  })

  server.get('/admin/config', async (req, reply) => {
    const { store } = storeQuerySchema.parse(req.query)
    const storeId = await requireInstall(store, reply)
    if (!storeId) return
    const cfg = await prisma.storeConfig.findUnique({ where: { storeId } })
    return { conversionRate: cfg?.conversionRate ?? DEFAULT_CONVERSION_RATE }
  })

  server.patch('/admin/config', async (req, reply) => {
    const { store } = storeQuerySchema.parse(req.query)
    const storeId = await requireInstall(store, reply)
    if (!storeId) return
    const parsed = configBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' })
    }
    const cfg = await prisma.storeConfig.upsert({
      where: { storeId },
      create: { storeId, conversionRate: parsed.data.conversionRate },
      update: { conversionRate: parsed.data.conversionRate },
    })
    return { conversionRate: cfg.conversionRate }
  })

  server.get('/admin/rewards', async (req, reply) => {
    const { store } = storeQuerySchema.parse(req.query)
    if (!(await requireInstall(store, reply))) return
    return deps.loyalty.listAllRewards()
  })

  server.post('/admin/rewards', async (req, reply) => {
    const { store } = storeQuerySchema.parse(req.query)
    if (!(await requireInstall(store, reply))) return
    const parsed = rewardBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' })
    }
    const { name, couponValue, pointsCost } = parsed.data
    const reward = await deps.loyalty.createReward({
      name,
      description: JSON.stringify({ couponType: 'fixed', couponValue }),
      pointsCost,
      stock: REWARD_STOCK,
    })
    return reply.code(201).send(reward)
  })

  server.patch('/admin/rewards/:id', async (req, reply) => {
    const { store } = storeQuerySchema.parse(req.query)
    if (!(await requireInstall(store, reply))) return
    const { id } = rewardParamsSchema.parse(req.params)
    const parsed = rewardPatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' })
    }
    const update: Partial<{ name: string; description: string; pointsCost: number }> = {}
    if (parsed.data.name !== undefined) update.name = parsed.data.name
    if (parsed.data.pointsCost !== undefined) update.pointsCost = parsed.data.pointsCost
    if (parsed.data.couponValue !== undefined) {
      update.description = JSON.stringify({ couponType: 'fixed', couponValue: parsed.data.couponValue })
    }
    return deps.loyalty.updateReward(id, update)
  })

  server.delete('/admin/rewards/:id', async (req, reply) => {
    const { store } = storeQuerySchema.parse(req.query)
    if (!(await requireInstall(store, reply))) return
    const { id } = rewardParamsSchema.parse(req.params)
    await deps.loyalty.deleteReward(id)
    return reply.code(204).send()
  })
}
