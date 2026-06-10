# Jumpseller ↔ LoyaltyOS Connector — Design Spec

**Date:** 2026-06-05
**Status:** Approved (Phase 1)
**Author:** Alejandro Troncoso

## 1. Goal

Build a working integration between a Jumpseller store (`alejandrotest.jumpseller.com`)
and **LoyaltyOS** (open-source, self-hosted loyalty platform) in the form of a **Jumpseller App**:
a standalone backend ("the connector") that bridges both systems.

This is sub-project #1 of two. Sub-project #2 (out of scope here) is rewriting the
Jumpseller Apps documentation, using this connector as the worked "from scratch" example.

### Success criteria (Phase 1, all run locally at $0 cost)

A merchant can install the app via OAuth, and then:

1. **Earn** — a customer placing an order automatically accrues points in LoyaltyOS.
2. **Display** — the customer sees their points balance in a widget on the storefront.
3. **Redeem** — the customer redeems a LoyaltyOS reward and receives a single-use
   Jumpseller coupon applicable at checkout.

## 2. Constraints & decisions

| Decision | Choice | Rationale |
|---|---|---|
| Connector stack | Node 20 + Fastify 4 + TypeScript + Zod | Matches LoyaltyOS stack; clean doc example |
| Connector state | Stateful, own DB | Demonstrates real OAuth storage, HMAC, idempotency (the doc gaps) |
| Database | SQLite via Prisma (dev) | Single file, zero infra; Prisma matches LoyaltyOS; swap to Postgres in Phase 2 |
| LoyaltyOS | Docker Compose, seed creds `dev-key` / `prog_dev` | Open source MIT, runs at `localhost:3002` (inside the Codespace) |
| Dev/demo environment | **GitHub Codespaces** (4-core) | Runs the whole stack in the cloud; demos don't depend on the dev's laptop |
| Public HTTPS exposure | **Codespaces port forwarding** (public visibility) | Replaces cloudflared; stable `*.app.github.dev` URL that survives restarts |
| CI | **GitHub Actions** | Free for public repos; runs lint + tests on push/PR |
| Secrets | **Codespaces secrets** (+ Actions secrets) | `APP_SECRET`, LoyaltyOS API key, signing secret — never in the repo |
| Docs hosting (sub-project #2) | **GitHub Pages** | Docusaurus deploys here |
| Connector port | `3001` | Avoids LoyaltyOS (3002), admin (5173), portal (5174) |
| Redemption UX | Synchronous (customer waits for code) | Cleaner demo than webhook-driven |
| Widget balance auth | Connector as signed intermediary | Show balance without separate LoyaltyOS login (see §6) |

### Cost: Phase 1 is $0
The whole stack runs inside a **GitHub Codespace** (within the free 120 core-hours/month +
15 GB storage). The connector port is forwarded with **public** visibility, giving a stable
`*.app.github.dev` HTTPS URL for the OAuth callback and webhooks — it does **not** change on
restart. Demos work for anyone, remotely, and the developer's laptop can be off: the Codespace
is started from github.com (even a phone).

**Caveats:** the Codespace auto-stops after inactivity (default 30 min) — not 24/7, so it's
started shortly before a demo. Running LoyaltyOS (Postgres + Redis + API + workers) **plus** the
connector needs a 4-core machine, which spends core-hours ~2× faster (120 core-hours ≈ 30 real
hours/month). Phase 2 (always-on production) is a swap, not a rewrite.

## 3. Architecture

```
┌─────────────────────┐         ┌────────────────────────┐         ┌─────────────────────┐
│  Jumpseller          │  OAuth  │   CONNECTOR (new)       │  REST   │  LoyaltyOS           │
│  alejandrotest.*     │◄───────►│  Node+Fastify+TS+SQLite │◄───────►│  Docker localhost:3002│
│  - order.created  ───┼────────►│  - OAuth (root/cb)      │         │  - POST /api/v1/events│
│  - Promotions API ◄──┼─────────│  - Webhook receiver     │         │  - members API       │
│  - JS App (widget)◄──┼─────────│  - Widget/balance API   │         │  - rewards/:id/redeem │
└─────────────────────┘         │  - Redeem endpoint      │         │  - <loyalty-widget>  │
        ▲                        └────────────────────────┘         └─────────────────────┘
        │   public HTTPS (Codespaces forwarded port, public) → :3001
```

## 4. Connector modules

### 4.1 OAuth module
- **Root route** (`GET /`): entry point rendered in Jumpseller's admin iframe; shows setup status.
- **Callback route** (`GET /oauth/callback`): exchanges `code` → `access_token`, persists to `Install`.
- **Scopes requested:** `read_orders`, `read_customers`, `write_promotions`, `write_jsapps`,
  `write_hooks`, `read_store`.
- **On install (post-token):** auto-register the `order.created` webhook (pointing at the tunnel
  URL) and create the JS App that injects the storefront widget — both via the Jumpseller API.

### 4.2 Webhook receiver (`POST /webhooks/jumpseller`)
1. Verify HMAC-SHA256 signature → reject 401 if invalid.
2. Idempotency: skip if event already in `ProcessedWebhook`; respond 200 fast.
3. Resolve customer email → find-or-create LoyaltyOS member; cache in `MemberMap`.
4. `POST /api/v1/events` to LoyaltyOS with `{ type: 'purchase', amount, currency, memberId }`
   + `Idempotency-Key`. LoyaltyOS points engine accrues points by its own rules.
5. On failure: retry with backoff; exhausted → `DeadLetter` table.

### 4.3 Widget / balance (`GET /widget/data`)
- The injected JS App reads the logged-in customer's email from the storefront (`{{ customer.email }}`).
- It requests a short-lived signed token from the connector, then fetches balance.
- The connector validates the token, looks up the member, and returns the balance from LoyaltyOS.
- Renders LoyaltyOS's `<loyalty-widget>` for balance display + a minimal custom "redeem" control.

### 4.4 Redeem (`POST /redeem`)
1. Receives `{ memberId, rewardId }` from the storefront widget.
2. `POST /api/v1/rewards/:id/redeem` on LoyaltyOS with `Idempotency-Key`.
3. On success, create a single-use Jumpseller **promotion/coupon** (value from the reward)
   via the Promotions API.
4. Persist to `Redemption`; return the coupon code to the customer for checkout.

## 5. Data model (connector SQLite DB)

- `Install(storeId, storeUrl, accessToken, scopes, installedAt)`
- `MemberMap(storeId, jumpsellerCustomerId, email, loyaltyMemberId)`
- `ProcessedWebhook(storeId, eventId, processedAt)` — webhook idempotency
- `Redemption(id, storeId, memberId, rewardId, couponCode, status, createdAt)`
- `DeadLetter(id, storeId, payload, error, attempts, createdAt)` — exhausted retries

## 6. Security

- **Widget balance access** *(revised in Plan 4)*: Jumpseller's JS Apps and storefront JS library
  cannot attest the logged-in customer, so a "signed intermediary" cannot bind a token to a session
  it can't see. The theme exposes `{{ customer.email }}` via a meta tag, and the connector's
  balance endpoint accepts an email but returns ONLY a points count: zero PII, no member ids,
  unknown emails return a flat `{points: 0}` (no membership signal), per-IP rate limiting.
  The LoyaltyOS API key never reaches the browser. True per-customer authentication (portal
  session / magic-link attestation) is a Phase 2 item.
- **Webhook authenticity:** HMAC-SHA256 verification on every inbound Jumpseller webhook,
  using a constant-time comparison (`crypto.timingSafeEqual`) **before** any payload field is
  read or acted upon — otherwise a forged webhook could trigger arbitrary point mutations.
- **OAuth secrets:** `APP_SECRET`, LoyaltyOS API key, and signing secret in env vars, never in client code.
- **Token at rest:** the Jumpseller `accessToken` stored in `Install` must be encrypted at rest
  (e.g. AES-256-GCM, matching LoyaltyOS's own credential handling) and never returned in error
  responses or logs. *(Flagged by the Plan 1 security review for the OAuth slice.)*

## 7. Error handling (the gaps in current Jumpseller docs)

- Webhooks respond `200` quickly after enqueue; processing uses retry + exponential backoff.
- Double-layer idempotency: at webhook ingest (`ProcessedWebhook`) and toward LoyaltyOS (`Idempotency-Key`).
- HMAC failures → `401`, logged.
- OAuth token expiry/refresh handled if Jumpseller issues refresh tokens; otherwise re-auth prompt.
- Exhausted retries land in `DeadLetter` for inspection.

## 8. Testing

- **Framework:** Vitest + Supertest (LoyaltyOS convention).
- **Unit:** HMAC verification, points-event mapping, idempotency dedup, coupon creation payload.
- **Integration:** against a locally running LoyaltyOS (Docker Compose, inside the Codespace).
- **CI:** GitHub Actions runs lint + unit/integration tests on push and PR.
- **E2E (manual):** real test store via the Codespace public URL; verified with the `jumpseller-api` skill.

## 9. Run / demo environment (Phase 1) — GitHub Codespaces

A `.devcontainer` defines the environment (Node 20, Docker-in-Docker for LoyaltyOS, pnpm).

1. Open the repo in a Codespace (4-core).
2. LoyaltyOS: `docker compose up -d` (API at `:3002`, seed `dev-key`/`prog_dev`).
3. Connector: `pnpm dev` → port `3001`.
4. Set port `3001` forwarding to **public** → copy the `*.app.github.dev` URL.
5. Jumpseller App config: Root URL + Redirect URL = that URL; install on `alejandrotest`.
6. Secrets (`APP_SECRET`, LoyaltyOS API key, signing secret) come from Codespaces secrets, not files.

The forwarded URL is stable for the Codespace's lifetime, so OAuth callback + webhook are
configured once. To demo, start the Codespace (laptop not required) and confirm the stack is up.

## 10. Out of scope (Phase 1)

- Customer-sync webhook (`customer.created`) — earn flow creates members lazily on first order.
- Always-on production hosting, Postgres (Phase 2 swaps — Codespaces is dev/demo, not 24/7).
- The documentation rewrite (sub-project #2).
- Multi-store support beyond what the data model already allows.

## 11. Open items deferred to the plan

- Exact LoyaltyOS `/api/v1/events` payload shape (confirm against its OpenAPI at `/docs`).
- Exact Jumpseller Promotions API fields for single-use coupons (confirm via `jumpseller-api` skill).
- Confirm the `<loyalty-widget>` embed works in the storefront (default per §4.3);
  fallback is a thin custom balance UI rendered by the injected JS.
