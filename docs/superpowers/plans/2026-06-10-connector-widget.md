# Connector Widget Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** A logged-in customer sees their points balance in the storefront. The connector serves the widget script (injected via Jumpseller JS Apps) and a balance endpoint backed by LoyaltyOS.

**Key constraint (confirmed against Jumpseller docs):** neither JS Apps nor the storefront `Jumpseller` JS library expose the logged-in customer's identity. The identity must come from the THEME: a Liquid snippet renders `<meta name="loyaltyos-customer-email" content="{{ customer.email }}">` (empty when not logged in). For `alejandrotest` we control the theme locally (`theme/`).

**Security trade-off (Phase 1, explicit):** a browser can fake the meta tag, so the balance endpoint cannot truly authenticate the customer from a pure storefront widget. Mitigations now: the endpoint returns ONLY `{points}` (no PII, no member id), per-IP rate limit, and store scoping. Phase 2 fix: authenticated session attestation (LoyaltyOS portal login / magic link). This supersedes the spec §4.3 "signed intermediary" idea, which could not actually attest identity either — documented in the spec.

---

### Task 1: Balance endpoint
**Files:** `src/routes/widget.ts`, test `tests/routes/widget.test.ts`; modify `src/server.ts`, `src/index.ts`; extend `src/loyaltyos/client.ts` with `getMemberBalance(memberId)`.

**CONFIRMED LoyaltyOS shape (from packages/core/src/service.ts):** `GET /api/v1/members/:id/balance` → `{data: {confirmed: number, pending: number, total: number}}` (zeros when no account). The widget displays `confirmed`.

`GET /widget/balance?email=...&store=...`:
1. Validate email (Zod). 2. Look up `MemberMap` by `{storeId, email}` — **only mapped members** (i.e. customers who already purchased) resolve; unknown → `{points: 0}` (no member enumeration signal). 3. `loyalty.getMemberBalance(loyaltyMemberId)` → reply `{points}`. CORS: `Access-Control-Allow-Origin: *` (public, non-sensitive payload). In-memory per-IP rate limit (60/min) — Phase-1 single process.

### Task 2: Widget script
**Files:** `src/routes/widget.ts` (add `GET /widget.js`), test asserts content-type `application/javascript` and that the script body references the meta tag + balance URL.
Vanilla JS (no framework, ~1 KB): reads the meta tag; if email present, fetches `${APP_URL}/widget/balance`, renders a fixed-position badge "⭐ N puntos" linking to the LoyaltyOS portal URL. `APP_URL` is baked in server-side when serving the script.

### Task 3: Theme snippet + install wiring
- `oauthRoutes` callback: after hook registration, also `client.createJsApp(`${appUrl}/widget.js`, 'layout', 'body')` (idempotent-ish: tolerate failure with notice, same pattern as the hook).
- Add `theme-snippet/loyaltyos-meta.liquid` to the repo + README instructions: paste `<meta name="loyaltyos-customer-email" content="{{ customer.email }}">` into the theme `layout.liquid` `<head>`.

### Task 4: Reviews + PR (same gate as Plans 1–3)

## Self-Review notes
- Spec §4.3 deviation documented above (update spec §6 in this PR).
- Widget JS served by us → no third-party CDN, no tokens in the browser.
- `LoyaltyOsClient` balance-route shape MUST be confirmed from LoyaltyOS source before implementing Task 1 (flagged; do not guess).
