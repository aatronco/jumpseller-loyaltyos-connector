# RFC: Loyalty Program Integration for Jumpseller Stores

**Status:** Proposed  
**Author:** Product — Alejandro Troncoso  
**Reviewers:** Apps Team  
**Date:** 2026-06-16  
**Reference repository (PoC):** `aatronco/jumpseller-loyaltyos-connector`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Business Case](#2-business-case)
3. [Proposed Solution](#3-proposed-solution)
4. [Validation Evidence](#4-validation-evidence)
5. [Integration Specification](#5-integration-specification)
6. [Non-Functional Requirements](#6-non-functional-requirements)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Delivery Phases](#8-delivery-phases)
9. [What Is NOT Prescribed](#9-what-is-not-prescribed)
10. [Appendix](#10-appendix)

---

## 1. Executive Summary

Loyalty programs are one of the most effective mechanisms for increasing purchase frequency and customer lifetime value (LTV). Today, no Jumpseller merchant can activate a points program without resorting to disconnected external solutions, creating operational friction and intent abandonment.

This document specifies a **Jumpseller App** that connects any Jumpseller store to a loyalty engine ([LoyaltyOS](https://github.com/loyalty-os/loyaltyos)), covering the full cycle: points accrual on purchase, reward management by the merchant, and discount redemption by the customer at checkout.

The integration was validated in a functional end-to-end prototype. This RFC delivers to the Apps team the **technical integration contract** that the production implementation must satisfy, without prescribing internal architecture or hosting infrastructure.

---

## 2. Business Case

### 2.1 The Problem

| Dimension | Current situation |
|---|---|
| **Retention** | Jumpseller merchants have no native points/loyalty tool |
| **Customer experience** | Shoppers have no brand-specific reason to return when prices are equivalent elsewhere |
| **Merchant operations** | External solutions (Smile.io, Yotpo) are expensive for the SMB segment and not integrated into the Jumpseller checkout |
| **Jumpseller ecosystem** | The App Store offers no active loyalty solution |

### 2.2 The Opportunity

A well-integrated points program directly impacts three key metrics:

- **Repurchase rate**: a customer with accrued points has a concrete economic incentive to return before the points expire or a competitor wins them over.
- **AOV (Average Order Value)**: customers who are close to a redemption threshold tend to add more items to their cart.
- **Merchant churn**: offering a native loyalty tool increases the platform exit cost for merchants.

### 2.3 Why This Approach

Rather than building a loyalty engine from scratch, this proposal relies on **LoyaltyOS**, a self-hostable open-source engine that handles points logic, events, rewards, and redemptions. Jumpseller only builds the **connector**: the layer that translates Jumpseller events (paid orders, app installs) into LoyaltyOS operations, and exposes a configuration panel to the merchant.

This reduces development time from months to weeks and eliminates the debt of maintaining loyalty logic internally.

---

## 3. Proposed Solution

### 3.1 System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Jumpseller                                  │
│                                                                     │
│  ┌──────────────┐   OAuth 2.0    ┌────────────────────────────────┐ │
│  │  Admin Panel │ ◄────────────► │                                │ │
│  │  (merchant)  │                │    LoyaltyOS Connector App     │ │
│  └──────┬───────┘   Webhooks     │    (this specification)        │ │
│         │          ────────────► │                                │ │
│  ┌──────▼───────┐                └──────────────┬─────────────────┘ │
│  │  Storefront  │   Widget JS                   │                   │
│  │  (shopper)   │ ◄─────────────────────────────┘  REST API         │
│  └──────────────┘                                      │            │
└────────────────────────────────────────────────────────┼────────────┘
                                                         ▼
                                              ┌──────────────────────┐
                                              │      LoyaltyOS       │
                                              │  (points engine,     │
                                              │   hosted by          │
                                              │   Jumpseller)        │
                                              └──────────────────────┘
```

### 3.2 Scope of This Specification

| # | Feature | Description |
|---|---|---|
| F-01 | **OAuth Install** | The merchant installs the app and authorizes access to their store |
| F-02 | **Points Accrual** | For each paid order, the shopper earns points according to the configured rate |
| F-03 | **Admin Panel** | The merchant configures the conversion rate and manages the rewards catalog from the Jumpseller admin |
| F-04 | **Storefront Widget** | The shopper sees their point balance and available rewards in the store |
| F-05 | **Reward Redemption** | The shopper redeems points for a discount coupon applicable at checkout |
| F-06 | **Uninstall** | When the app is uninstalled, the install data is correctly cleaned up |

### 3.3 Out of Scope (v1)

- Points accrual for non-transactional actions (referrals, reviews, birthdays)
- Tier/level programs (Bronze, Silver, Gold)
- Multi-currency within a single program
- Widget white-labeling by the merchant

---

## 4. Validation Evidence

The prototype `aatronco/jumpseller-loyaltyos-connector` implements all F-01 through F-06 flows in a working integration against the `alejandrotest.jumpseller.com` store and a local LoyaltyOS instance.

**What was validated in production:**

- Full OAuth install with automatic webhook registration
- Points accrual on receiving the `order_paid` webhook
- Admin panel embedded in the Jumpseller App Store (new tab) with HMAC capability-URL authentication
- JS widget injected via JS App showing real-time balance and rewards in the storefront
- End-to-end redemption: shopper redeems points → LoyaltyOS deducts balance → Jumpseller creates discount coupon → code returned to widget

**Known limitations of the PoC (to be resolved in production):**

| PoC Limitation | Production Expectation |
|---|---|
| LoyaltyOS runs in local Docker | LoyaltyOS hosted and managed by Jumpseller infrastructure |
| Ephemeral tunnel (Cloudflare) for HTTPS | Stable domain with TLS (Heroku/AWS/etc.) |
| SQLite as database | Managed Postgres or equivalent RDBMS |
| Static admin token (HMAC without expiry) | Signed session with expiry or HttpOnly cookie |
| Single shared LoyaltyOS for all stores | Confirm whether the model is multi-tenant or one instance per merchant |

---

## 5. Integration Specification

This section defines the **observable contract** that the production implementation MUST satisfy. Internal implementation details are left to the Apps team's discretion.

---

### 5.1 OAuth 2.0 — App Installation

#### Flow

```
Merchant clicks "Install" in the App Store
    │
    ▼
GET /oauth/install?store={storeId}
    │  Connector builds the Jumpseller authorization URL
    ▼
302 → https://accounts.jumpseller.com/oauth/authorize?...
    │  Merchant approves permissions
    ▼
GET /oauth/callback?code={authCode}&state={csrfToken}
    │  Connector exchanges code for access_token + refresh_token
    │  Connector persists the installation in the database
    │  Connector registers required webhooks via Jumpseller API
    ▼
302 → {appUrl}/?store={storeId}&token={adminToken}
    (admin panel)
```

#### Required Scopes

```
read_orders
read_customers
write_promotions
write_jsapps
write_hooks
read_store
```

#### Webhook Auto-Registered at Install

| Event | Target URL |
|---|---|
| `order_paid` | `{appUrl}/webhooks/order_paid` |

#### Minimum Persistence per Installation

| Field | Type | Description |
|---|---|---|
| `storeId` | string (PK) | Unique store identifier (slug) |
| `storeUrl` | string | Store base URL |
| `accessToken` | string (encrypted) | OAuth access token |
| `refreshToken` | string (encrypted) | OAuth refresh token |
| `tokenExpiresAt` | timestamp | Access token expiry |
| `scopes` | string | Authorized scopes |
| `createdAt` | timestamp | Installation date |

> **Security requirement:** `accessToken` and `refreshToken` MUST be stored encrypted at rest. The PoC uses AES-256-GCM with `TOKEN_ENCRYPTION_KEY`.

---

### 5.2 Webhook — Points Accrual

#### Endpoint

```
POST /webhooks/order_paid
```

#### Signature Verification

Jumpseller signs the payload with HMAC-SHA256. The connector MUST verify the signature before processing:

```
X-Jumpseller-Hmac-SHA256: {base64(HMAC-SHA256(webhookSecret, rawBody))}
```

Reject with `401` if the signature does not match.

#### Accrual Logic

```
pointsEarned = floor(order.total / conversionRate)
```

Where `conversionRate` is the merchant-configured rate (default: 1 point per 1000 CLP).

#### Idempotency

Every order processing MUST be idempotent. Recommended idempotency key:

```
{storeId}:order_paid:{orderId}
```

Already-processed orders must respond `200` without duplicating points.

#### Internal Flow

```
1. Verify HMAC signature → 401 if failed
2. Look up installation by storeId → 404 if not found
3. Get or create LoyaltyOS member by shopper email
4. Calculate points according to merchant's conversionRate
5. Record 'purchase' event in LoyaltyOS with Idempotency-Key
6. Respond 200
```

---

### 5.3 Merchant Admin Panel

#### Access

The panel opens from Apps → My Apps → [app name] in the Jumpseller admin. The connector serves an HTML page embedded or in a new tab.

#### Access URL

```
GET /?store={storeId}&token={adminToken}
```

`adminToken` = `HMAC-SHA256(ADMIN_TOKEN_SECRET, storeId)` in hex (256 bits). Embedded in the App URL configured in the app registration.

> **Security note:** The token is a static capability URL. For production it is recommended to upgrade to a JWT with a short expiry (`exp`) or an HttpOnly + SameSite=Strict session cookie.

#### Exposed Features

**Conversion Rate**

```
GET  /admin/config?store={storeId}
     → { conversionRate: number }

PATCH /admin/config?store={storeId}
     Body: { conversionRate: number }   // positive integer
     → { conversionRate: number }
```

**Reward Management**

```
GET    /admin/rewards?store={storeId}
       → Reward[]

POST   /admin/rewards?store={storeId}
       Body: { name: string, couponValue: number, pointsCost: number }
       → Reward (201)

PATCH  /admin/rewards/:id?store={storeId}
       Body: Partial<{ name, couponValue, pointsCost }>
       → Reward

DELETE /admin/rewards/:id?store={storeId}
       → 204
```

All admin endpoints require the header:
```
X-Admin-Token: {adminToken}
```

#### Reward Model

```ts
interface Reward {
  id: string
  name: string
  pointsCost: number
  isActive: boolean
  stock: number
  description: string | null  // JSON: { couponType: 'fixed', couponValue: number }
}
```

---

### 5.4 Storefront Widget

The widget is injected into the store via a **Jumpseller JS App**. The JS App executes the following snippet on the storefront:

```html
<script src="{appUrl}/widget.js" async></script>
```

The script self-initializes when it detects `window.__jsloyalty` or an element with `data-loyalty-widget`.

#### Endpoints Consumed by the Widget

```
GET /widget/balance?email={email}&store={storeId}&customerId={id}
    → { points: number }

GET /widget/rewards?store={storeId}
    → Reward[]

POST /widget/redeem
     Body: { email, store, rewardId, customerId }
     → { couponCode: string, pointsUsed: number, remainingPoints: number }
```

#### Error States for `/widget/redeem`

| HTTP | Meaning |
|---|---|
| 402 | Insufficient points |
| 404 | Member or reward not found |
| 422 | LoyaltyOS rejected the redemption (out of stock, inactive reward) |
| 502 | Error creating the coupon in Jumpseller (redemption already recorded — do not reverse) |

---

### 5.5 Discount Coupons (Jumpseller Promotions API)

When redeeming a reward, the connector MUST create a coupon in Jumpseller using the Promotions API:

```
POST /promotions.json
{
  "promotion": {
    "name": "{rewardName} — {email}",
    "type": "fix",
    "status": "enabled",
    "discount": {couponValue},
    "usage_limit": 1,
    "start_date": "{today}",
    "end_date": "{today + 30 days}"
  }
}
```

> **Known gotcha:** The `type` field in Jumpseller's response returns `"percentage_off"` even when `"fix"` is sent. Do not confuse the request field with the response field. Documented in the PoC.

---

### 5.6 Uninstall

Jumpseller sends an uninstall event when the merchant removes the app. The connector MUST:

1. Delete the installation record from the database
2. (Optional v1) Notify LoyaltyOS to archive the program

---

### 5.7 Required Environment Variables

| Variable | Description | Validation |
|---|---|---|
| `APP_URL` | Public connector URL | Valid URL |
| `JUMPSELLER_APP_ID` | Client ID of the registered app | required |
| `JUMPSELLER_APP_SECRET` | Client Secret of the app | required |
| `JUMPSELLER_SCOPES` | OAuth scopes | see §5.1 |
| `JUMPSELLER_WEBHOOK_SECRET` | Secret for verifying HMAC signatures | required |
| `ADMIN_TOKEN_SECRET` | Independent secret for admin tokens | 64 hex chars (32 bytes) |
| `TOKEN_ENCRYPTION_KEY` | Key for encrypting OAuth tokens in DB | 64 hex chars (32 bytes) |
| `LOYALTYOS_API_URL` | LoyaltyOS instance base URL | Valid URL |
| `LOYALTYOS_API_KEY` | LoyaltyOS API key | required |
| `LOYALTYOS_PROGRAM_ID` | Program ID in LoyaltyOS | required |
| `DATABASE_URL` | Database connection string | required |

> `JUMPSELLER_WEBHOOK_SECRET` and `ADMIN_TOKEN_SECRET` MUST be independent values. Sharing the same key across different security domains invalidates isolation in the event of a compromise.

---

## 6. Non-Functional Requirements

| Requirement | Description |
|---|---|
| **Idempotency** | Processing of any webhook MUST be idempotent. Jumpseller may deliver the same event more than once. |
| **Encryption at rest** | `accessToken` and `refreshToken` MUST be stored encrypted. |
| **No secrets in logs** | The admin URL `token` MUST be redacted before writing to the access log. |
| **HTTPS required** | All connector endpoints MUST be served over HTTPS. |
| **Webhook availability** | The `/webhooks/order_paid` endpoint MUST respond in < 5 s. Jumpseller considers the webhook failed after that time and retries. |
| **Input validation** | Every API body and query parameter MUST be validated before processing. Reject with `400` on invalid schemas. |

---

## 7. Acceptance Criteria

An implementation is considered complete when:

- [ ] A merchant can install the app from the Jumpseller App Store without manual intervention
- [ ] When an order is completed, the shopper automatically earns points; accrual is idempotent
- [ ] The merchant can configure the conversion rate from the admin panel without leaving Jumpseller
- [ ] The merchant can create, edit, and delete rewards from the admin panel
- [ ] The shopper can view their point balance in the store
- [ ] The shopper can redeem points for a valid coupon that works at checkout
- [ ] When the app is uninstalled, the installation data is deleted
- [ ] All admin endpoints return `403` when invoked without a valid token
- [ ] The webhook returns `401` if the HMAC signature does not match
- [ ] Access/refresh tokens do not appear in plain text in the database or in logs

---

## 8. Delivery Phases

### Phase 1 — MVP (recommended as first milestone)

Flows F-01, F-02, F-03, and F-06. The merchant can install, view the admin panel, and accrue points. No storefront widget.

**Definition of done:** A real merchant can install the app, generate a test order, and verify that points were accrued from the admin panel.

### Phase 2 — Storefront Widget

Flows F-04 and F-05. The shopper can view their points and redeem them.

**Definition of done:** A shopper in the store can see their balance, select a reward, obtain a coupon code, and apply it at checkout.

### Phase 3 — Stabilization and Observability

- Handling of expired OAuth token refresh
- Alerts if the webhook fails in a sustained manner
- Basic metrics dashboard (active installs, points issued, redemptions)

---

## 9. What Is NOT Prescribed

This RFC defines the **what** (observable behavior) but not the **how** (internal implementation). The following decisions are entirely at the Apps team's discretion:

- **Language and framework**: the PoC uses TypeScript + Fastify, but any stack is valid
- **Infrastructure**: Heroku, AWS, Railway, Fly.io, or any platform with HTTPS and PostgreSQL
- **ORM / data access**: Prisma (used in PoC), Drizzle, raw SQL, or any alternative
- **Deployment strategy**: CI/CD, Docker, buildpacks, etc.
- **LoyaltyOS tenant model**: a single shared multi-tenant instance or one instance per merchant — both are compatible with this specification, as long as the correct `programId` is used per installation
- **Admin panel session strategy**: the PoC uses HMAC capability-URL; production may upgrade to JWT with expiry or session cookies

---

## 10. Appendix

### 10.1 Proof of Concept Reference

| Artifact | Location |
|---|---|
| Connector repository (PoC) | `github.com/aatronco/jumpseller-loyaltyos-connector` |
| Test store | `alejandrotest.jumpseller.com` |
| LoyaltyOS (open source) | `github.com/loyalty-os/loyaltyos` |

The PoC has unit and integration test coverage for all flows specified in §5. It is recommended to review the tests as executable documentation of the expected behavior.

### 10.2 LoyaltyOS Endpoints Used

| Operation | Method | Path |
|---|---|---|
| Find member | `GET` | `/api/v1/members?search={email}` |
| Create member | `POST` | `/api/v1/members` |
| Record purchase event | `POST` | `/api/v1/events` |
| Get balance | `GET` | `/api/v1/members/{id}/balance` |
| List rewards (admin) | `GET` | `/api/v1/admin/rewards` |
| Create reward (admin) | `POST` | `/api/v1/admin/rewards` |
| Update reward (admin) | `PATCH` | `/api/v1/admin/rewards/{id}` |
| Delete reward (admin) | `DELETE` | `/api/v1/admin/rewards/{id}` |

### 10.3 Glossary

| Term | Definition |
|---|---|
| **Merchant** | Jumpseller store owner who installs the app |
| **Shopper** | End customer who purchases in the merchant's store |
| **Points** | Loyalty unit accrued through purchases |
| **Reward** | Benefit redeemable for points (in this v1: fixed-amount discount coupons) |
| **Conversion rate** | Amount in CLP required to earn 1 point |
| **Capability URL** | A URL that incorporates an access token as a parameter; whoever holds the URL holds the access |
| **LoyaltyOS** | Open-source loyalty engine that manages points, events, and rewards |
| **Connector** | This app: the integration layer between Jumpseller and LoyaltyOS |
