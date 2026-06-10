# Connector Redeem Implementation Plan (Plan 5)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** A customer redeems a LoyaltyOS reward from the storefront and receives a single-use Jumpseller coupon code for checkout.

**Confirmed LoyaltyOS shapes (source):** `GET /api/v1/rewards/:id` → `{data: reward}` (reward: id, isActive, stock, pointsCost, tierRequired?, metadata?). `POST /api/v1/rewards/:id/redeem` body `{rewardId, memberId, idempotencyKey}` → 201 `{data: {redemption: {id, rewardId, memberId, pointsSpent}, transaction: {...}}}`; throws on insufficient points (→ non-2xx).

**UNCONFIRMED Jumpseller shape (no public docs/swagger for promotions):** `POST /promotions.json` payload is an educated guess, isolated in `JumpsellerClient.createDiscountCoupon` and marked LIVE-CONFIRM. The `write_promotions` scope exists, so the endpoint almost certainly exists; the exact field names must be validated against the live store at deploy and adjusted in ONE place.

**Reward→coupon mapping:** the reward's `metadata` must carry `{couponType: 'fixed'|'percent', couponValue: number}`. Rewards without it are rejected (422 `unsupported_reward`) — explicit beats guessing a conversion rate.

**Failure mode (documented):** if LoyaltyOS redeem succeeds but coupon creation fails, points were spent without a coupon. Phase 1: persist `Redemption` with status `failed_coupon` + DeadLetter row (manual fix); Phase 2: automatic reversal via LoyaltyOS adjust/reverse.

## Tasks
1. **LoyaltyOS client**: `getReward(id)`, `redeemReward({rewardId, memberId, idempotencyKey})`. TDD mocked.
2. **Jumpseller client**: `createDiscountCoupon({code, type, value})` → `POST /promotions.json` (LIVE-CONFIRM payload). TDD mocked.
3. **Redeem route** `POST /widget/redeem` body `{email, store, rewardId}` (CORS, rate-limited 10/min/IP):
   unknown member → 404; reward without coupon metadata → 422; LoyaltyOS redeem (idempotencyKey = `store:redeem:<memberId>:<rewardId>:<redemptionNonce>`), then `getValidAccessToken` → create coupon `LOYAL-<random>` → persist `Redemption(completed)` → `{code}`. Coupon-creation failure → `Redemption(failed_coupon)` + DeadLetter + 502. Deps: `{loyalty, oauthApp, encryptionKey, fetchFn?}`. TDD: happy path (Install seeded with valid token), unknown member, unsupported reward, insufficient points (LoyaltyOS 4xx → 402 `insufficient_points`), coupon failure path.
4. **Widget script**: extend with a minimal redeem flow (click badge → prompt for reward id → POST → alert code). Demo-grade by design; the polished UI is the LoyaltyOS portal.
5. Reviews + PR (same gate as previous plans).

## Self-Review notes
- Spec §4.4 covered; redemption sync (customer waits) per spec decision.
- Both idempotency layers preserved (LoyaltyOS idempotencyKey; Redemption row is the audit trail).
- The only invented API shape is quarantined in one client method with a LIVE-CONFIRM marker.
