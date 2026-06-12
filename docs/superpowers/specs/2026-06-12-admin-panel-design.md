# Admin Panel Design

## Goal

A merchant-facing configuration panel served in the Jumpseller admin iframe. Merchants can set the conversion rate (CLP per loyalty point) and manage rewards (discount coupons). No stats, no campaigns — configuration only.

## Architecture

**New file:** `src/routes/admin.ts` — registers all admin routes and serves the HTML shell.

**New routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves the HTML admin panel shell |
| `GET` | `/admin/config?store=X` | Returns `{ conversionRate: number }` |
| `PATCH` | `/admin/config?store=X` | Updates conversion rate `{ conversionRate: number }` |
| `GET` | `/admin/rewards?store=X` | Lists rewards from LoyaltyOS |
| `POST` | `/admin/rewards?store=X` | Creates a reward in LoyaltyOS |
| `PATCH` | `/admin/rewards/:id?store=X` | Updates a reward in LoyaltyOS |
| `DELETE` | `/admin/rewards/:id?store=X` | Deletes a reward from LoyaltyOS |

All `/admin/*` routes validate that `store` exists in the `Install` table. Missing `store` → 400. Unknown `store` → 404.

**Updated file:** `src/server.ts` — registers `adminRoutes` (always, no feature flag needed).

## Data Model

New Prisma model added to `prisma/schema.prisma`:

```prisma
model StoreConfig {
  storeId        String  @id
  conversionRate Float   @default(1000)
  updatedAt      DateTime @updatedAt
}
```

`conversionRate` is CLP per point (e.g. `1000` means 1 pt per $1,000 CLP). Default is `1000`.

**Updated file:** `src/routes/webhooks.ts` — when processing `order_paid`, read `StoreConfig` for the store (falling back to `1000` if not set) and compute points as `Math.floor(subtotal / conversionRate)` before calling `recordPurchase`.

## LoyaltyOS Client

Three new methods added to `src/loyaltyos/client.ts`, all calling the LoyaltyOS `/admin/rewards` endpoints with the same `X-API-Key` and `X-Program-Id` headers:

```ts
createReward(input: { name: string; description: string; pointsCost: number; stock: number }): Promise<Reward>
updateReward(id: string, input: Partial<{ name: string; description: string; pointsCost: number; stock: number }>): Promise<Reward>
deleteReward(id: string): Promise<void>
```

The `description` field stores coupon config as JSON: `{"couponType":"fixed","couponValue":<amount>}`. The `stock` defaults to `9999` (effectively unlimited) when creating.

## UI

Single HTML page served from `adminHtml(appUrl)` function (same pattern as `widgetScript()` in `widget.ts`).

**Layout:**

```
┌─────────────────────────────────────────┐
│  LoyaltyOS — Configuración              │
├─────────────────────────────────────────┤
│  Tasa de conversión                     │
│  1 punto por cada [ 1000 ] CLP          │
│                          [ Guardar ]    │
├─────────────────────────────────────────┤
│  Recompensas                [ + Nueva ] │
│                                         │
│  Café gratis      300 pts   [✎] [✕]    │
│  Gift card $2000  500 pts   [✎] [✕]    │
│                                         │
│  ── inline form (create / edit) ────────│
│  Título: [____________]                 │
│  Descuento ($): [______]                │
│  Costo (pts): [________]                │
│                 [Cancelar] [Guardar]    │
└─────────────────────────────────────────┘
```

**Behaviour:**
- On load: two parallel `fetch()` calls — `/admin/config?store=X` and `/admin/rewards?store=X`. `store` is read from `window.location.search`.
- Conversion rate: number input, saves on button click via `PATCH /admin/config`.
- Rewards list: each row shows name + points cost + edit + delete buttons.
- New/edit form: inline below the list (not a modal). Pre-filled on edit. Hidden when inactive.
- All discounts are fixed CLP (`couponType: "fixed"`). No percent option.
- Errors shown inline below the relevant input. No `alert()`.
- Stock is set to `9999` on create and never exposed in the UI.

## Webhook change

`src/routes/webhooks.ts` currently hardcodes the point calculation implicitly (LoyaltyOS PointRule multiplier handles it). After this change:

1. On `order_paid`, load `StoreConfig` for the store (or use default `1000`).
2. Compute `points = Math.floor(order.subtotal / conversionRate)`.
3. Call `loyalty.recordPurchase({ ..., amount: points })` — passing **points directly**, not the CLP amount.

This is a breaking change to the existing `webhooks.test.ts`: the test currently asserts `amount: 25990` (CLP); after this change it must assert `amount: 25` (points = `Math.floor(25990 / 1000)`).

`LoyaltyOsClient.recordPurchase` keeps its current signature — `amount` stays a number, but its meaning shifts from CLP to points. No interface change needed, only the caller changes.

The LoyaltyOS PointRule multiplier must be `1` (pass-through) for this to work correctly. Update the dev seed's PointRule to `multiplier: 1`. In the live LoyaltyOS instance, update the existing rule via the LoyaltyOS admin panel or directly in the DB.

## Auth

All `/admin/*` handlers share a small helper:

```ts
async function requireInstall(store: string | undefined): Promise<Install>
```

Throws `400` if `store` is missing, `404` if no `Install` row exists. Called at the top of every handler.

## Tests

`tests/routes/admin.test.ts` — integration tests using the same `buildServer` + `prisma` pattern as existing test files:

- `GET /` returns 200 with `text/html`
- `GET /admin/config` returns default rate for a new store
- `PATCH /admin/config` updates the rate and returns the new value
- `GET /admin/config` returns 400 with no store, 404 for unknown store
- `POST /admin/rewards` creates a reward and returns it
- `PATCH /admin/rewards/:id` updates name and pointsCost
- `DELETE /admin/rewards/:id` removes the reward
- Reward endpoints return 404 for an unknown store

LoyaltyOS calls are stubbed via the same `buildServer({ admin: { loyalty: stubLoyalty() } })` dependency injection pattern.
