# Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a merchant-facing admin panel (conversion rate + reward CRUD) and update the webhook to compute points using the stored conversion rate instead of passing raw CLP.

**Architecture:** New `StoreConfig` Prisma model stores per-store conversion rate. A new `src/routes/admin.ts` registers all `/admin/*` routes (JSON API + HTML shell) and uses the same `buildServer` dependency-injection pattern as existing route plugins. The webhook handler reads `StoreConfig` and passes computed points to LoyaltyOS.

**Tech Stack:** Prisma (SQLite), Fastify, Zod, Vitest (integration tests), vanilla HTML/JS (no frontend build step)

**Spec:** `docs/superpowers/specs/2026-06-12-admin-panel-design.md`

---

### Task 1: Add `StoreConfig` Prisma model + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Run: `pnpm exec prisma migrate dev`

- [ ] **Step 1: Add the model to the schema**

In `prisma/schema.prisma`, append after the last model:

```prisma
model StoreConfig {
  storeId        String   @id
  conversionRate Float    @default(1000)
  updatedAt      DateTime @updatedAt
}
```

- [ ] **Step 2: Run migration**

```bash
cd /Users/alejandro/code/support/alejandrotest/jumpseller-loyaltyos-connector
pnpm exec prisma migrate dev --name add_store_config
```

Expected output: migration applied, `StoreConfig` table created.

- [ ] **Step 3: Verify Prisma client regenerated**

```bash
pnpm exec prisma generate
```

- [ ] **Step 4: Run existing tests to confirm nothing broke**

```bash
pnpm test
```

Expected: all 60 tests still pass.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add StoreConfig model (conversion rate per store)"
```

---

### Task 2: Update webhook to use conversion rate

**Files:**
- Modify: `src/routes/webhooks.ts`
- Modify: `tests/routes/webhooks.test.ts`

- [ ] **Step 1: Update the failing test first (TDD)**

In `tests/routes/webhooks.test.ts`, line 108, change `amount: 25990` to `amount: 25` (= `Math.floor(25990 / 1000)`):

```ts
expect(loyalty.recordPurchase).toHaveBeenCalledWith({
  memberId: 'loy_777',
  amount: 25,            // ← was 25990; now points = Math.floor(25990 / 1000)
  currency: 'CLP',
  orderId: '1026',
  idempotencyKey: `${STORE}:order_paid:1026`,
})
```

Also add `storeConfig` cleanup to `beforeEach` (the webhook test uses store `'store_wh'`):

```ts
beforeEach(async () => {
  await prisma.processedWebhook.deleteMany({ where: { storeId: STORE } })
  await prisma.memberMap.deleteMany({ where: { storeId: STORE } })
  await prisma.deadLetter.deleteMany({ where: { storeId: STORE } })
  await prisma.storeConfig.deleteMany({ where: { storeId: STORE } })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm test tests/routes/webhooks.test.ts
```

Expected: the "processes a valid order_paid" test fails with `expected 25990, received 25990` (still passes — the code hasn't changed yet, which is correct for TDD; we'll see the mismatch after we change the source).

- [ ] **Step 3: Implement the conversion rate lookup in webhooks.ts**

Replace the `recordPurchase` call block (lines 85–91 in `src/routes/webhooks.ts`):

```ts
      // Load per-store conversion rate (CLP per point); default 1000 if not configured.
      const config = await prisma.storeConfig.findUnique({ where: { storeId } })
      const conversionRate = config?.conversionRate ?? 1000
      const clp = order.subtotal ?? order.total
      const points = Math.floor(clp / conversionRate)

      await deps.loyalty.recordPurchase({
        memberId,
        amount: points,
        currency: order.currency,
        orderId: String(order.id),
        idempotencyKey: `${storeId}:${eventId}`,
      })
```

The full `try` block in the `order_paid` handler should now look like:

```ts
    try {
      const memberId = await getOrCreateLoyaltyMember(
        storeId,
        { id: order.customer.id, email: order.customer.email },
        deps.loyalty,
      )
      const cfg = await prisma.storeConfig.findUnique({ where: { storeId } })
      const conversionRate = cfg?.conversionRate ?? 1000
      const clp = order.subtotal ?? order.total
      const points = Math.floor(clp / conversionRate)
      await deps.loyalty.recordPurchase({
        memberId,
        amount: points,
        currency: order.currency,
        orderId: String(order.id),
        idempotencyKey: `${storeId}:${eventId}`,
      })
    } catch (err) {
      await prisma.processedWebhook.deleteMany({ where: { storeId, eventId } })
      await prisma.deadLetter.create({
        data: {
          storeId,
          payload: rawBody.toString('utf8'),
          error: err instanceof Error ? err.message : String(err),
          attempts: 1,
        },
      })
      return reply.code(500).send({ error: 'processing_failed' })
    }
```

- [ ] **Step 4: Run webhook tests**

```bash
pnpm test tests/routes/webhooks.test.ts
```

Expected: all webhook tests pass.

- [ ] **Step 5: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/webhooks.ts tests/routes/webhooks.test.ts
git commit -m "feat: compute points from StoreConfig conversion rate in webhook"
```

---

### Task 3: Add admin methods to LoyaltyOsClient

**Files:**
- Modify: `src/loyaltyos/client.ts`
- Modify: `tests/loyaltyos/client.test.ts`

The LoyaltyOS admin rewards API is `/admin/rewards` (POST/GET/PATCH/DELETE), with the same `X-API-Key` and `X-Program-Id` headers used by the existing `request<T>` method.

- [ ] **Step 1: Write failing tests**

Open `tests/loyaltyos/client.test.ts`. Add a new `describe('admin rewards')` block at the end:

```ts
describe('admin rewards', () => {
  it('createReward posts to /admin/rewards and returns the reward', async () => {
    const reward: Reward = { id: 'r1', name: 'Café gratis', isActive: true, pointsCost: 300, stock: 9999, description: '{"couponType":"fixed","couponValue":500}' }
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify({ data: reward })) })
    const client = new LoyaltyOsClient({ apiUrl: 'http://los', apiKey: 'k', programId: 'p' }, fetch as unknown as typeof globalThis.fetch)

    const result = await client.createReward({ name: 'Café gratis', description: '{"couponType":"fixed","couponValue":500}', pointsCost: 300, stock: 9999 })

    expect(fetch).toHaveBeenCalledWith(
      'http://los/admin/rewards',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Café gratis', description: '{"couponType":"fixed","couponValue":500}', pointsCost: 300, stock: 9999 }) }),
    )
    expect(result).toEqual(reward)
  })

  it('updateReward patches /admin/rewards/:id', async () => {
    const updated: Reward = { id: 'r1', name: 'Café grande', isActive: true, pointsCost: 400, stock: 9999, description: null }
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify({ data: updated })) })
    const client = new LoyaltyOsClient({ apiUrl: 'http://los', apiKey: 'k', programId: 'p' }, fetch as unknown as typeof globalThis.fetch)

    const result = await client.updateReward('r1', { name: 'Café grande', pointsCost: 400 })

    expect(fetch).toHaveBeenCalledWith(
      'http://los/admin/rewards/r1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Café grande', pointsCost: 400 }) }),
    )
    expect(result).toEqual(updated)
  })

  it('deleteReward sends DELETE to /admin/rewards/:id', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') })
    const client = new LoyaltyOsClient({ apiUrl: 'http://los', apiKey: 'k', programId: 'p' }, fetch as unknown as typeof globalThis.fetch)

    await client.deleteReward('r1')

    expect(fetch).toHaveBeenCalledWith(
      'http://los/admin/rewards/r1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('listAllRewards fetches /admin/rewards', async () => {
    const rewards: Reward[] = [{ id: 'r1', name: 'Café gratis', isActive: true, pointsCost: 300, stock: 9999, description: null }]
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify({ data: { items: rewards } })) })
    const client = new LoyaltyOsClient({ apiUrl: 'http://los', apiKey: 'k', programId: 'p' }, fetch as unknown as typeof globalThis.fetch)

    const result = await client.listAllRewards()

    expect(fetch).toHaveBeenCalledWith('http://los/admin/rewards', expect.objectContaining({ method: 'GET' }))
    expect(result).toEqual(rewards)
  })
})
```

Note: you need `Reward` imported at the top — check the existing imports in the test file and add it if missing.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm test tests/loyaltyos/client.test.ts
```

Expected: 4 new tests fail with "not a function" errors.

- [ ] **Step 3: Add methods to LoyaltyOsClient**

In `src/loyaltyos/client.ts`, add after `recordPurchase`:

```ts
  async createReward(input: {
    name: string
    description: string
    pointsCost: number
    stock: number
  }): Promise<Reward> {
    const json = await this.request<{ data: Reward }>('POST', '/admin/rewards', { body: input })
    return json.data
  }

  async updateReward(
    id: string,
    input: Partial<{ name: string; description: string; pointsCost: number; stock: number }>,
  ): Promise<Reward> {
    const json = await this.request<{ data: Reward }>('PATCH', `/admin/rewards/${encodeURIComponent(id)}`, { body: input })
    return json.data
  }

  async deleteReward(id: string): Promise<void> {
    await this.request('DELETE', `/admin/rewards/${encodeURIComponent(id)}`)
  }

  async listAllRewards(): Promise<Reward[]> {
    const json = await this.request<{ data: { items: Reward[] } }>('GET', '/admin/rewards')
    return json.data.items
  }
```

- [ ] **Step 4: Run tests**

```bash
pnpm test tests/loyaltyos/client.test.ts
```

Expected: all client tests pass (8 existing + 4 new = 12).

- [ ] **Step 5: Run full suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/loyaltyos/client.ts tests/loyaltyos/client.test.ts
git commit -m "feat: add createReward, updateReward, deleteReward, listAllRewards to LoyaltyOsClient"
```

---

### Task 4: Create `src/routes/admin.ts` with tests

**Files:**
- Create: `src/routes/admin.ts`
- Create: `tests/routes/admin.test.ts`

This is the largest task. The admin routes include:
- `GET /` — serves the HTML panel
- `GET /admin/config?store=X` — returns `{ conversionRate: number }`
- `PATCH /admin/config?store=X` — updates conversion rate
- `GET /admin/rewards?store=X` — lists rewards from LoyaltyOS
- `POST /admin/rewards?store=X` — creates a reward
- `PATCH /admin/rewards/:id?store=X` — updates a reward
- `DELETE /admin/rewards/:id?store=X` — deletes a reward

All `/admin/*` routes (except `GET /`) call `requireInstall(store)` which throws `400` if `store` missing, `404` if no `Install` row.

- [ ] **Step 1: Write the test file first**

Create `tests/routes/admin.test.ts`:

```ts
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { buildServer } from '../../src/server.js'
import { prisma } from '../../src/db.js'
import type { LoyaltyOsClient } from '../../src/loyaltyos/client.js'
import type { Reward } from '../../src/loyaltyos/client.js'

const STORE = 'store_admin'
const APP_URL = 'https://conn.test'

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.storeConfig.deleteMany({ where: { storeId: STORE } })
  await prisma.install.deleteMany({ where: { storeId: STORE } })
})

interface AdminStub {
  listAllRewards: ReturnType<typeof vi.fn>
  createReward: ReturnType<typeof vi.fn>
  updateReward: ReturnType<typeof vi.fn>
  deleteReward: ReturnType<typeof vi.fn>
}

function stubLoyalty(rewards: Reward[] = []): AdminStub {
  return {
    listAllRewards: vi.fn().mockResolvedValue(rewards),
    createReward: vi.fn().mockResolvedValue({ id: 'r_new', name: 'Test', isActive: true, pointsCost: 100, stock: 9999, description: '{"couponType":"fixed","couponValue":1000}' }),
    updateReward: vi.fn().mockResolvedValue({ id: 'r1', name: 'Updated', isActive: true, pointsCost: 200, stock: 9999, description: null }),
    deleteReward: vi.fn().mockResolvedValue(undefined),
  }
}

async function seedInstall() {
  await prisma.install.create({
    data: {
      storeId: STORE,
      storeUrl: 'https://store_admin.jumpseller.com',
      accessToken: 'tok',
      refreshToken: 'ref',
      scopes: 'read_orders',
      tokenExpiresAt: new Date(Date.now() + 86400_000),
    },
  })
}

function appWith(loyalty: AdminStub) {
  return buildServer({ admin: { loyalty: loyalty as unknown as LoyaltyOsClient, appUrl: APP_URL } })
}

describe('GET /', () => {
  it('returns 200 with text/html', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    await app.close()
  })
})

describe('GET /admin/config', () => {
  it('returns 400 when store param is missing', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: '/admin/config' })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('returns 404 for an unknown store', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: '/admin/config?store=unknown_store' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns default conversion rate for a new store', async () => {
    await seedInstall()
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: `/admin/config?store=${STORE}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ conversionRate: 1000 })
    await app.close()
  })
})

describe('PATCH /admin/config', () => {
  it('updates the conversion rate and returns new value', async () => {
    await seedInstall()
    const app = appWith(stubLoyalty())
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/config?store=${STORE}`,
      payload: { conversionRate: 500 },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ conversionRate: 500 })

    // Verify it persisted
    const row = await prisma.storeConfig.findUnique({ where: { storeId: STORE } })
    expect(row?.conversionRate).toBe(500)
    await app.close()
  })
})

describe('GET /admin/rewards', () => {
  it('returns 404 for unknown store', async () => {
    const app = appWith(stubLoyalty())
    const res = await app.inject({ method: 'GET', url: '/admin/rewards?store=nope' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns the rewards list from LoyaltyOS', async () => {
    await seedInstall()
    const rewards: Reward[] = [
      { id: 'r1', name: 'Café gratis', isActive: true, pointsCost: 300, stock: 9999, description: '{"couponType":"fixed","couponValue":500}' },
    ]
    const loyalty = stubLoyalty(rewards)
    const app = appWith(loyalty)
    const res = await app.inject({ method: 'GET', url: `/admin/rewards?store=${STORE}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(rewards)
    expect(loyalty.listAllRewards).toHaveBeenCalledTimes(1)
    await app.close()
  })
})

describe('POST /admin/rewards', () => {
  it('creates a reward in LoyaltyOS and returns it', async () => {
    await seedInstall()
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const res = await app.inject({
      method: 'POST',
      url: `/admin/rewards?store=${STORE}`,
      payload: { name: 'Test', couponValue: 1000, pointsCost: 100 },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(201)
    expect(loyalty.createReward).toHaveBeenCalledWith({
      name: 'Test',
      description: JSON.stringify({ couponType: 'fixed', couponValue: 1000 }),
      pointsCost: 100,
      stock: 9999,
    })
    await app.close()
  })
})

describe('PATCH /admin/rewards/:id', () => {
  it('updates name and pointsCost in LoyaltyOS', async () => {
    await seedInstall()
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/rewards/r1?store=${STORE}`,
      payload: { name: 'New name', pointsCost: 200 },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(loyalty.updateReward).toHaveBeenCalledWith('r1', expect.objectContaining({ name: 'New name', pointsCost: 200 }))
    await app.close()
  })
})

describe('DELETE /admin/rewards/:id', () => {
  it('removes the reward from LoyaltyOS', async () => {
    await seedInstall()
    const loyalty = stubLoyalty()
    const app = appWith(loyalty)
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/rewards/r1?store=${STORE}`,
    })
    expect(res.statusCode).toBe(204)
    expect(loyalty.deleteReward).toHaveBeenCalledWith('r1')
    await app.close()
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm test tests/routes/admin.test.ts
```

Expected: tests fail because `admin` option doesn't exist in `buildServer` yet.

- [ ] **Step 3: Create `src/routes/admin.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import type { LoyaltyOsClient } from '../loyaltyos/client.js'
import type { Install } from '@prisma/client'

export interface AdminRoutesDeps {
  loyalty: LoyaltyOsClient
  appUrl: string
}

async function requireInstall(store: string | undefined, reply: Parameters<Parameters<FastifyInstance['get']>[1]>[1]): Promise<Install | null> {
  if (!store) {
    reply.code(400).send({ error: 'missing_store' })
    return null
  }
  const install = await prisma.install.findUnique({ where: { storeId: store } })
  if (!install) {
    reply.code(404).send({ error: 'store_not_found' })
    return null
  }
  return install
}

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
    <button class="primary" onclick="saveConversionRate()">Guardar</button>
  </div>
  <div class="error" id="config-error"></div>
</section>

<section id="rewards-section">
  <div class="section-header">
    <h2>Recompensas</h2>
    <button class="primary" onclick="showNewForm()">+ Nueva</button>
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
      <button onclick="cancelForm()">Cancelar</button>
      <button class="primary" onclick="submitRewardForm()">Guardar</button>
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

  function qs(id) { return document.getElementById(id) }
  function clearErrors() {
    ['config-error','f-name-error','f-value-error','f-cost-error','form-error'].forEach(function(id) {
      var el = qs(id); if (el) el.textContent = ''
    })
  }

  function load() {
    Promise.all([
      fetch(API + '/admin/config?store=' + store).then(function(r) { return r.json() }),
      fetch(API + '/admin/rewards?store=' + store).then(function(r) { return r.json() }),
    ]).then(function(results) {
      var cfg = results[0]; var rewards = results[1]
      qs('conversion-rate').value = cfg.conversionRate || 1000
      renderRewards(rewards)
    }).catch(function() {
      qs('config-error').textContent = 'Error cargando configuración.'
    })
  }

  function renderRewards(rewards) {
    var list = qs('rewards-list')
    if (!rewards || rewards.length === 0) {
      list.innerHTML = '<p style="font-size:0.85rem;color:#888">Sin recompensas. Crea una con + Nueva.</p>'
      return
    }
    list.innerHTML = rewards.map(function(r) {
      var desc = {}
      try { desc = JSON.parse(r.description || '{}') } catch(e) {}
      var val = desc.couponValue ? ('$' + desc.couponValue) : ''
      return '<div class="reward-row">' +
        '<div class="reward-info"><strong>' + escHtml(r.name || '') + '</strong> ' + val + ' &mdash; ' + r.pointsCost + ' pts</div>' +
        '<div class="reward-actions">' +
        '<button onclick="editReward(' + JSON.stringify(r) + ')">✎</button>' +
        '<button class="danger" onclick="removeReward(' + JSON.stringify(r.id) + ')">✕</button>' +
        '</div></div>'
    }).join('')
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  }

  window.saveConversionRate = function() {
    clearErrors()
    var rate = parseFloat(qs('conversion-rate').value)
    if (!rate || rate < 1) { qs('config-error').textContent = 'Ingresa un valor válido.'; return }
    fetch(API + '/admin/config?store=' + store, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversionRate: rate }),
    }).then(function(r) {
      if (!r.ok) throw new Error()
      return r.json()
    }).then(function(data) {
      qs('conversion-rate').value = data.conversionRate
    }).catch(function() {
      qs('config-error').textContent = 'Error guardando tasa.'
    })
  }

  window.showNewForm = function() {
    editingId = null
    qs('f-name').value = ''; qs('f-value').value = ''; qs('f-cost').value = ''
    clearErrors()
    qs('reward-form').style.display = 'block'
  }

  window.editReward = function(r) {
    editingId = r.id
    qs('f-name').value = r.name || ''
    var desc = {}
    try { desc = JSON.parse(r.description || '{}') } catch(e) {}
    qs('f-value').value = desc.couponValue || ''
    qs('f-cost').value = r.pointsCost || ''
    clearErrors()
    qs('reward-form').style.display = 'block'
  }

  window.cancelForm = function() {
    qs('reward-form').style.display = 'none'
    editingId = null
  }

  window.submitRewardForm = function() {
    clearErrors()
    var name = qs('f-name').value.trim()
    var val = parseInt(qs('f-value').value, 10)
    var cost = parseInt(qs('f-cost').value, 10)
    var ok = true
    if (!name) { qs('f-name-error').textContent = 'Requerido'; ok = false }
    if (!val || val < 1) { qs('f-value-error').textContent = 'Ingresa un monto'; ok = false }
    if (!cost || cost < 1) { qs('f-cost-error').textContent = 'Ingresa un costo'; ok = false }
    if (!ok) return

    var url, method, body
    if (editingId) {
      url = API + '/admin/rewards/' + encodeURIComponent(editingId) + '?store=' + store
      method = 'PATCH'
      body = JSON.stringify({ name: name, couponValue: val, pointsCost: cost })
    } else {
      url = API + '/admin/rewards?store=' + store
      method = 'POST'
      body = JSON.stringify({ name: name, couponValue: val, pointsCost: cost })
    }

    fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function(r) { if (!r.ok) throw new Error(); return r.json() })
      .then(function() {
        qs('reward-form').style.display = 'none'
        editingId = null
        load()
      }).catch(function() {
        qs('form-error').textContent = 'Error guardando recompensa.'
      })
  }

  window.removeReward = function(id) {
    fetch(API + '/admin/rewards/' + encodeURIComponent(id) + '?store=' + store, { method: 'DELETE' })
      .then(function(r) { if (!r.ok && r.status !== 204) throw new Error(); load() })
      .catch(function() { alert('Error eliminando recompensa.') })
  }

  load()
})()
</script>
</body>
</html>`
}

const configQuerySchema = z.object({ store: z.string().min(1).optional() })
const configBodySchema = z.object({ conversionRate: z.number().positive() })
const rewardBodySchema = z.object({
  name: z.string().min(1),
  couponValue: z.number().positive(),
  pointsCost: z.number().int().positive(),
})
const rewardPatchSchema = rewardBodySchema.partial()
const rewardParamsSchema = z.object({ id: z.string().min(1) })

export async function adminRoutes(server: FastifyInstance, deps: AdminRoutesDeps): Promise<void> {
  server.get('/', async (_req, reply) => {
    return reply.type('text/html').send(adminHtml(deps.appUrl))
  })

  server.get('/admin/config', async (req, reply) => {
    const { store } = configQuerySchema.parse(req.query)
    if (!await requireInstall(store, reply)) return
    const cfg = await prisma.storeConfig.findUnique({ where: { storeId: store! } })
    return { conversionRate: cfg?.conversionRate ?? 1000 }
  })

  server.patch('/admin/config', async (req, reply) => {
    const { store } = configQuerySchema.parse(req.query)
    if (!await requireInstall(store, reply)) return
    const { conversionRate } = configBodySchema.parse(req.body)
    const cfg = await prisma.storeConfig.upsert({
      where: { storeId: store! },
      create: { storeId: store!, conversionRate },
      update: { conversionRate },
    })
    return { conversionRate: cfg.conversionRate }
  })

  server.get('/admin/rewards', async (req, reply) => {
    const { store } = configQuerySchema.parse(req.query)
    if (!await requireInstall(store, reply)) return
    return deps.loyalty.listAllRewards()
  })

  server.post('/admin/rewards', async (req, reply) => {
    const { store } = configQuerySchema.parse(req.query)
    if (!await requireInstall(store, reply)) return
    const { name, couponValue, pointsCost } = rewardBodySchema.parse(req.body)
    const reward = await deps.loyalty.createReward({
      name,
      description: JSON.stringify({ couponType: 'fixed', couponValue }),
      pointsCost,
      stock: 9999,
    })
    return reply.code(201).send(reward)
  })

  server.patch('/admin/rewards/:id', async (req, reply) => {
    const { store } = configQuerySchema.parse(req.query)
    if (!await requireInstall(store, reply)) return
    const { id } = rewardParamsSchema.parse(req.params)
    const patch = rewardPatchSchema.parse(req.body)
    const update: Record<string, unknown> = {}
    if (patch.name !== undefined) update.name = patch.name
    if (patch.pointsCost !== undefined) update.pointsCost = patch.pointsCost
    if (patch.couponValue !== undefined) update.description = JSON.stringify({ couponType: 'fixed', couponValue: patch.couponValue })
    return deps.loyalty.updateReward(id, update)
  })

  server.delete('/admin/rewards/:id', async (req, reply) => {
    const { store } = configQuerySchema.parse(req.query)
    if (!await requireInstall(store, reply)) return
    const { id } = rewardParamsSchema.parse(req.params)
    await deps.loyalty.deleteReward(id)
    return reply.code(204).send()
  })
}
```

- [ ] **Step 4: Run admin tests**

```bash
pnpm test tests/routes/admin.test.ts
```

Expected: tests still fail (admin not registered in `buildServer` yet).

- [ ] **Step 5: Register admin routes in `src/server.ts`**

Add the import at the top of `src/server.ts`:

```ts
import { adminRoutes, type AdminRoutesDeps } from './routes/admin.js'
```

Add `admin?: AdminRoutesDeps` to `ServerOptions`:

```ts
export interface ServerOptions {
  oauth?: OAuthRoutesDeps
  webhooks?: WebhookRoutesDeps
  widget?: WidgetRoutesDeps
  redeem?: RedeemRoutesDeps
  admin?: AdminRoutesDeps
}
```

Add the registration inside `buildServer` (always, no feature flag):

```ts
  app.register(adminRoutes, opts.admin ?? { loyalty: {} as LoyaltyOsClient, appUrl: '' })
```

Wait — the HTML route `GET /` must always be served (even without a configured loyalty client) because Jumpseller will load it in the iframe. The correct approach is: register admin routes unconditionally but provide deps from `opts.admin` if present, or require `opts.admin`. Looking at the spec: "registers `adminRoutes` (always, no feature flag needed)".

Better approach — make `admin` required in the actual `buildServer` call in `index.ts`, but keep the option optional in `ServerOptions` for tests that don't care about admin. Register only when provided (same pattern as other routes), since tests that don't pass `admin` don't exercise those routes.

The test passes `{ admin: { loyalty, appUrl } }`, so the conditional registration pattern works:

```ts
  if (opts.admin) {
    app.register(adminRoutes, opts.admin)
  }
```

Use this simpler conditional pattern.

Full updated `src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import { healthRoutes } from './routes/health.js'
import { oauthRoutes, type OAuthRoutesDeps } from './routes/oauth.js'
import { webhookRoutes, type WebhookRoutesDeps } from './routes/webhooks.js'
import { widgetRoutes, type WidgetRoutesDeps } from './routes/widget.js'
import { redeemRoutes, type RedeemRoutesDeps } from './routes/redeem.js'
import { adminRoutes, type AdminRoutesDeps } from './routes/admin.js'

export interface ServerOptions {
  oauth?: OAuthRoutesDeps
  webhooks?: WebhookRoutesDeps
  widget?: WidgetRoutesDeps
  redeem?: RedeemRoutesDeps
  admin?: AdminRoutesDeps
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { level: 'info' } })
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
  if (opts.admin) {
    app.register(adminRoutes, opts.admin)
  }
  return app
}
```

- [ ] **Step 6: Run admin tests**

```bash
pnpm test tests/routes/admin.test.ts
```

Expected: all admin tests pass.

- [ ] **Step 7: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass (60+ including new admin tests).

- [ ] **Step 8: Commit**

```bash
git add src/routes/admin.ts tests/routes/admin.test.ts src/server.ts
git commit -m "feat: add admin panel routes (config, rewards CRUD, HTML shell)"
```

---

### Task 5: Wire admin into `src/index.ts` + update LoyaltyOS PointRule

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add admin to `buildServer` call in `src/index.ts`**

In `src/index.ts`, add `admin` to the `buildServer` options:

```ts
const app = buildServer({
  oauth: {
    app: {
      appId: config.JUMPSELLER_APP_ID,
      appSecret: config.JUMPSELLER_APP_SECRET,
      redirectUri: `${config.APP_URL}/oauth/callback`,
      scopes: config.JUMPSELLER_SCOPES,
    },
    encryptionKey: config.TOKEN_ENCRYPTION_KEY,
    appUrl: config.APP_URL,
  },
  webhooks: {
    webhookSecret: config.JUMPSELLER_WEBHOOK_SECRET,
    loyalty,
  },
  widget: {
    loyalty,
    appUrl: config.APP_URL,
  },
  redeem: {
    loyalty,
    oauthApp: {
      appId: config.JUMPSELLER_APP_ID,
      appSecret: config.JUMPSELLER_APP_SECRET,
      redirectUri: `${config.APP_URL}/oauth/callback`,
      scopes: config.JUMPSELLER_SCOPES,
    },
    encryptionKey: config.TOKEN_ENCRYPTION_KEY,
  },
  admin: {
    loyalty,
    appUrl: config.APP_URL,
  },
})
```

- [ ] **Step 2: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 3: Build and restart the connector**

```bash
pnpm build && pkill -f "node dist/index.js" || true && node dist/index.js > /tmp/connector.log 2>&1 &
sleep 2 && tail -5 /tmp/connector.log
```

Expected: `"Server listening at http://0.0.0.0:3001"`.

- [ ] **Step 4: Test the admin panel in the browser**

Navigate to `<APP_URL>/?store=alejandrotest` in a browser. You should see the admin panel HTML with the conversion rate input and rewards section.

- [ ] **Step 5: Update the LoyaltyOS PointRule multiplier to 1**

The dev LoyaltyOS seed sets a PointRule multiplier. With the new design, points are pre-computed by the webhook — LoyaltyOS must treat them as pass-through (`multiplier: 1`).

Connect to the LoyaltyOS dev DB and verify/update:

```bash
# Check current multiplier
psql postgresql://postgres:postgres@localhost:5432/loyaltyos -c "SELECT id, multiplier FROM \"PointRule\" WHERE \"programId\" = 'prog_dev';"
# If not 1:
psql postgresql://postgres:postgres@localhost:5432/loyaltyos -c "UPDATE \"PointRule\" SET multiplier = 1 WHERE \"programId\" = 'prog_dev';"
```

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire admin routes into production server"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| `StoreConfig` Prisma model | Task 1 |
| `GET /`, `GET/PATCH /admin/config`, `GET/POST/PATCH/DELETE /admin/rewards/:id` | Task 4 |
| `requireInstall` → 400/404 validation | Task 4 (in `requireInstall` helper) |
| `createReward`, `updateReward`, `deleteReward` on `LoyaltyOsClient` | Task 3 |
| Webhook reads `StoreConfig`, computes `Math.floor(subtotal / conversionRate)` | Task 2 |
| Webhook test `amount: 25990` → `amount: 25` breaking change | Task 2 |
| `adminRoutes` registered in `server.ts` | Task 4, Step 5 |
| `admin: { loyalty, appUrl }` added to `index.ts` | Task 5 |
| LoyaltyOS PointRule `multiplier: 1` | Task 5, Step 5 |
| HTML shell with conversion rate UI + rewards CRUD UI | Task 4 |
| `description` stores JSON `{"couponType":"fixed","couponValue":<n>}` | Task 3 (createReward) + Task 4 |
| `stock: 9999` on create, not exposed in UI | Task 4 |

All spec requirements covered. No gaps found.

### Placeholder scan

No TBDs, no "implement later", no vague steps. All code blocks are complete.

### Type consistency

- `AdminRoutesDeps` defined in `admin.ts`, imported in `server.ts` — consistent.
- `listAllRewards` defined in Task 3, used in admin route — consistent.
- `createReward` signature `{ name, description, pointsCost, stock }` — consistent across Tasks 3 and 4.
- `updateReward(id, patch)` signature — consistent across Tasks 3 and 4.
