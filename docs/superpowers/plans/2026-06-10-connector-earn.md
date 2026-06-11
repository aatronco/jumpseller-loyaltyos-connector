# Connector Earn Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** When a customer pays an order in the Jumpseller store, the connector receives the signed `order_paid` webhook, verifies it (HMAC, timing-safe, raw body), deduplicates it, finds-or-creates the LoyaltyOS member by email, and records a `purchase` event in LoyaltyOS so points accrue. Plus two hardening items carried from the Plan 2 review.

**Architecture:** Webhook route registered with a raw-body content parser so the HMAC is computed over the exact received bytes. Idempotency via unique insert on `ProcessedWebhook` *before* processing (acts as a lock); on processing failure the row is removed, a `DeadLetter` row is written, and 500 is returned so Jumpseller's retry policy (4 retries) re-delivers. A small LoyaltyOS client (injectable `fetchFn`) handles member find-or-create and event recording. `MemberMap` caches email→loyaltyMemberId per store.

**Confirmed LoyaltyOS API shapes (from its source):**
- `POST /api/v1/events` body `{type, memberId?, payload?}`; REQUIRES `Idempotency-Key` header (400 without); idempotent replays return 200 `{data, idempotent:true}`. Auth: `X-API-Key`, `X-Program-Id`.
- `POST /api/v1/members` body `{email?, externalId?, firstName?, ...}` → 201 `{data: member}` (member.id). No duplicate-email guard → must search before create.
- `GET /api/v1/members?search=<q>` → `{items, total, ...}`; search is contains-match over email/firstName/lastName/externalId → filter exact email client-side.

**Confirmed Jumpseller webhook shapes (docs):** headers `Jumpseller-Event` (e.g. `order_paid`), `Jumpseller-Store-Code`, `Jumpseller-Hmac-Sha256` = base64(HMAC-SHA256(rawBody, webhook secret)); body `{order:{id, status, currency, total, customer:{id, email}, ...}}`. 2xx expected within 15s.

> **To confirm live at deploy:** the HMAC secret source (store "hooks token" from admin vs app secret). Config exposes `JUMPSELLER_WEBHOOK_SECRET` so either works.

---

### Task 1: Config + webhook signature verifier

**Files:** Modify `src/config.ts`, `.env.example`; Create `src/jumpseller/webhook-signature.ts`; Test `tests/jumpseller/webhook-signature.test.ts`

- Add to config schema: `JUMPSELLER_WEBHOOK_SECRET: z.string().min(1)` and to `.env.example`:
  `JUMPSELLER_WEBHOOK_SECRET=""  # store "hooks token" (Admin > Config > Notifications/Webhooks)`
- `verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean` — computes base64 HMAC-SHA256 of rawBody with secret; compares via `crypto.timingSafeEqual` AFTER an explicit length check (length mismatch → false, never throw); undefined/empty header → false.
- TDD: valid signature → true; wrong secret → false; tampered body → false; missing header → false; different-length header → false (no throw).
- Commit: `feat: add webhook signature verification (timing-safe HMAC over raw body)`

### Task 2: LoyaltyOS client

**Files:** Create `src/loyaltyos/client.ts`; Test `tests/loyaltyos/client.test.ts`

```ts
export interface LoyaltyOsConfig { apiUrl: string; apiKey: string; programId: string }
export class LoyaltyOsClient {
  constructor(cfg: LoyaltyOsConfig, fetchFn: typeof fetch = fetch)
  async findMemberByEmail(email: string): Promise<{ id: string } | null>  // GET /api/v1/members?search=..., exact-match filter on email (case-insensitive)
  async createMember(email: string): Promise<{ id: string }>              // POST /api/v1/members {email} → {data:{id}}
  async ensureMember(email: string): Promise<{ id: string }>              // find || create
  async recordPurchase(p: { memberId: string; amount: number; currency: string; orderId: string; idempotencyKey: string }): Promise<void>
  // POST /api/v1/events {type:'purchase', memberId, payload:{amount, currency, orderId}} with Idempotency-Key header; 2xx ok (200 idempotent replay also ok); else throw
}
```
All requests send `X-API-Key`, `X-Program-Id`, `Content-Type: application/json`. Non-2xx → throw with status. TDD with mocked fetch: headers asserted, search exact-match filtering (search returns contains-matches → must pick exact), create body, ensureMember both paths, recordPurchase body + Idempotency-Key + error path.
Commit: `feat: add LoyaltyOS client (members find-or-create, purchase events)`

### Task 3: Member mapping repository

**Files:** Create `src/members.ts`; Test `tests/members.test.ts`

`getOrCreateLoyaltyMember(storeId, customer: {id, email}, loyalty: LoyaltyOsClient): Promise<string>` —
1. `MemberMap.findUnique({storeId, jumpsellerCustomerId})` → hit: return `loyaltyMemberId`.
2. Miss: `loyalty.ensureMember(email)` → upsert MemberMap row → return id.
TDD against the real test DB + mocked LoyaltyOsClient (plain object): cache hit does NOT call ensureMember; miss calls it once and persists the mapping.
Commit: `feat: add member mapping repository (Jumpseller customer -> LoyaltyOS member)`

### Task 4: Webhook route + wiring

**Files:** Create `src/routes/webhooks.ts`; Modify `src/server.ts`, `src/index.ts`; Test `tests/routes/webhooks.test.ts`

`WebhookRoutesDeps { webhookSecret: string; loyalty: LoyaltyOsClient }` (route plugin; for tests `loyalty` can be a structurally-typed stub).

Route `POST /webhooks/jumpseller` registered with a scoped raw-body parser:
```ts
server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
```
(scoped: register inside the plugin so other routes keep normal JSON parsing — Fastify parsers are encapsulated per plugin context).

Handler order (security-review requirements):
1. `verifyWebhookSignature(rawBody, req.headers['jumpseller-hmac-sha256'], secret)` → false: 401, no parsing.
2. `JSON.parse(rawBody)`; read `Jumpseller-Event` + `Jumpseller-Store-Code` headers. Event !== 'order_paid' → 200 `{ignored:true}`.
3. Validate with Zod: `{order:{id, currency, total, customer:{id, email}}}` (coerce id/total numbers) → invalid: 400.
4. Idempotency lock: `prisma.processedWebhook.create({storeId, eventId: 'order_paid:'+order.id})`; on P2002 unique violation → 200 `{duplicate:true}`.
5. `getOrCreateLoyaltyMember(...)` → `loyalty.recordPurchase({memberId, amount: order.total, currency, orderId: String(order.id), idempotencyKey: storeId+':order_paid:'+order.id})`.
6. Success → 200 `{ok:true}`. Failure → delete the ProcessedWebhook row, write `DeadLetter {storeId, payload: rawBody.toString(), error: message}`, return 500 (Jumpseller retries).

`server.ts`: `ServerOptions` gains `webhooks?: WebhookRoutesDeps`; register when present. `index.ts`: build `LoyaltyOsClient` from config and wire `{webhookSecret: config.JUMPSELLER_WEBHOOK_SECRET, loyalty}`.

TDD via `app.inject` with real signed payloads (helper signs with the test secret): bad signature → 401 (and loyalty stub NOT called); non-order_paid event → 200 ignored; valid → 200, ProcessedWebhook row exists, stub called with right args; duplicate delivery → 200 duplicate + stub called once total; loyalty failure → 500 + DeadLetter row + ProcessedWebhook removed; malformed JSON body with valid signature → 400.
Commit: `feat: add signed order_paid webhook receiver wired to LoyaltyOS earn`

### Task 5: Plan-2 review hardening

**Files:** Modify `src/installs.ts`, `src/routes/oauth.ts`; Test extend `tests/installs.test.ts`, `tests/routes/oauth.test.ts`

- **Single-flight refresh** in `getValidAccessToken`: a module-level `Map<string, Promise<string>>` keyed by storeId; concurrent callers while a refresh is in flight await the same promise (cleared in `finally`). Test: two concurrent calls with expired token → fetch mock called exactly once, both get the new token.
- **Callback error handling** in `/oauth/callback`: wrap exchange→storeInfo→save→registerHook in try/catch → 502 `{error:'install_failed'}` (no token/secret material in the message). Hook registration failure AFTER saveInstall: still return 200 success page but include a notice that webhook registration must be retried (log it); test: registerHook rejecting → 200 with notice, install persisted.
- Commit: `fix: single-flight token refresh and resilient OAuth callback`

---

## Self-Review
- Spec §4.2 coverage: HMAC verify before parse ✓ (T1/T4), idempotency double-layer ✓ (ProcessedWebhook + Idempotency-Key, T4/T2), member find-or-create + MemberMap cache ✓ (T2/T3), POST /events purchase ✓ (T2), DeadLetter on exhausted processing ✓ (T4 — Jumpseller's own 4-retry policy is the retry/backoff layer; an internal queue would be redundant in Phase 1), 200-fast ✓ (inline processing is local/fast in Phase 1).
- Security carry-forwards (a)–(d) from memory: (a) T5, (b) T5, (c) T1/T4 raw-body timing-safe, (d) T4. (e) widget authZ → Plan 4.
- Types: `LoyaltyOsClient` consumed by T3/T4 via constructor injection; `WebhookRoutesDeps` mirrors the `OAuthRoutesDeps` pattern; ProcessedWebhook/DeadLetter/MemberMap fields match the Plan-1 schema exactly (no migration needed).
