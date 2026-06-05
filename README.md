# Jumpseller ↔ LoyaltyOS Connector

A **Jumpseller App** that bridges a [Jumpseller](https://jumpseller.com) store with
[LoyaltyOS](https://github.com/jvillatox/loyaltyos), the open-source self-hosted loyalty platform.
Customers earn points on purchases, see their balance in a storefront widget, and redeem rewards
for single-use coupons — all running locally at zero cost.

> **Status:** 🚧 Phase 1 in development. Design spec is approved; implementation plan next.

## What it does

| Flow | How |
|---|---|
| **Earn points** | Jumpseller `order.created` webhook → connector → LoyaltyOS `POST /api/v1/events` |
| **Show balance** | Connector-injected JS App renders a points widget on the storefront |
| **Redeem rewards** | Customer redeems a LoyaltyOS reward → connector mints a single-use Jumpseller coupon |

## Architecture

```
Jumpseller store  ◄──OAuth/API/webhooks──►  Connector (Node+Fastify+TS+SQLite)  ◄──REST──►  LoyaltyOS (Docker)
```

The connector is a standalone, stateful Jumpseller App: it stores OAuth installs, a
customer↔member mapping, and webhook idempotency keys. See the
[design spec](docs/superpowers/specs/2026-06-05-jumpseller-loyaltyos-connector-design.md)
for the full architecture, data model, and security model.

## Tech stack

Node 20 · Fastify 4 · TypeScript · Zod · Prisma + SQLite · Vitest. Runs in **GitHub Codespaces**
with a public forwarded port for OAuth callbacks and webhooks; **GitHub Actions** for CI.

## Goals

This project doubles as a **worked "from scratch" example** for rewriting the Jumpseller Apps
developer documentation, deliberately demonstrating the parts the current docs leave thin:
the full OAuth flow, webhook HMAC verification, idempotency, and error handling.

## Running in Codespaces

Open the repo in a GitHub Codespace — the devcontainer installs dependencies and generates the
Prisma client automatically. Then:

1. Start LoyaltyOS (Docker): `docker compose up -d` (from the LoyaltyOS repo).
2. Start the connector: `pnpm dev` (listens on port 3001).
3. **Make the connector reachable for OAuth callbacks and webhooks.** Codespaces does not let
   `devcontainer.json` set a port to public visibility (a security measure), so set it once after
   the Codespace starts:

   ```bash
   gh codespace ports visibility 3001:public -c $CODESPACE_NAME
   ```

   (Or right-click port **3001** in the Ports panel → *Port Visibility* → *Public*.) This yields
   the stable `*.app.github.dev` URL used for the Jumpseller OAuth callback and webhooks.

## License

MIT
