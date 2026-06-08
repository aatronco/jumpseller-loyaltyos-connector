# Connector OAuth + Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a Jumpseller merchant install the connector via OAuth 2 — the connector obtains and securely stores access/refresh tokens (encrypted), refreshes them automatically (Jumpseller tokens expire in 1h), fetches store info, and auto-registers the `order_paid` webhook so the earn flow (next plan) can fire.

**Architecture:** Dependency-injected, network-free-in-tests. OAuth/HTTP helpers are pure functions/classes that take an injectable `fetchFn` (defaults to global `fetch`). Config is validated once at the composition root (`index.ts`) and passed down; unit tests never touch real env or network. Tokens are encrypted at rest with AES-256-GCM (per the Plan 1 security review).

**Tech Stack:** Node 20 global `fetch`/`Response`, `node:crypto` (AES-256-GCM), Zod, Prisma, Fastify, dotenv (local dev only), Vitest.

**Confirmed external API shapes (from Jumpseller docs):**
- Authorize: `GET https://accounts.jumpseller.com/oauth/authorize?client_id&redirect_uri&response_type=code&scope=<space-separated>&state`
- Token / refresh: `POST https://accounts.jumpseller.com/oauth/token` (form-encoded). Response: `{access_token, token_type:"bearer", expires_in:3600, refresh_token, created_at}`.
- API: base `https://api.jumpseller.com/v1`, header `Authorization: Bearer <token>`. Single resources are wrapped (`{"store":{...}}`).
- `GET /store/info.json`, `POST /hooks.json {hook:{event,url}}`, `POST /jsapps.json {app:{url,template,element}}`. Earn event = `order_paid`.

> **Response-wrapping assumptions** (`{store}`, `{hook}`, `{app}`) are mocked in tests and must be confirmed against the live store before production. Flagged in the final task.

---

### Task 1: Config module (Zod-validated env)

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`
- Modify: `.env.example`
- Modify: `package.json` (add `dotenv` dependency)

- [ ] **Step 1: Add `dotenv` dependency**

Run: `pnpm add dotenv@^16.4.5`
Expected: added to `dependencies`, lockfile updated.

- [ ] **Step 2: Write the failing test** `tests/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

const valid = {
  APP_URL: 'https://example.app.github.dev',
  JUMPSELLER_APP_ID: 'app-id',
  JUMPSELLER_APP_SECRET: 'app-secret',
  TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
}

describe('loadConfig', () => {
  it('parses valid env and applies defaults', () => {
    const cfg = loadConfig(valid)
    expect(cfg.PORT).toBe(3001)
    expect(cfg.JUMPSELLER_SCOPES).toContain('read_orders')
    expect(cfg.LOYALTYOS_API_URL).toBe('http://localhost:3002')
    expect(cfg.LOYALTYOS_PROGRAM_ID).toBe('prog_dev')
  })

  it('throws when a required var is missing', () => {
    expect(() => loadConfig({ APP_URL: 'https://x.dev' })).toThrow(/Invalid configuration/)
  })

  it('throws when the encryption key is not 64 hex chars', () => {
    expect(() => loadConfig({ ...valid, TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(/Invalid configuration/)
  })
})
```

- [ ] **Step 3: Run `pnpm test`** → the 3 config tests FAIL (module missing).

- [ ] **Step 4: Implement** `src/config.ts`:

```ts
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  APP_URL: z.string().url(),
  JUMPSELLER_APP_ID: z.string().min(1),
  JUMPSELLER_APP_SECRET: z.string().min(1),
  JUMPSELLER_SCOPES: z
    .string()
    .default('read_orders read_customers write_promotions write_jsapps write_hooks read_store'),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex chars (32 bytes)'),
  LOYALTYOS_API_URL: z.string().url().default('http://localhost:3002'),
  LOYALTYOS_API_KEY: z.string().default('dev-key'),
  LOYALTYOS_PROGRAM_ID: z.string().default('prog_dev'),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${details}`)
  }
  return parsed.data
}
```

- [ ] **Step 5: Run `pnpm test`** → config tests PASS. **Step 6: `pnpm lint`** clean.

- [ ] **Step 7: Append to `.env.example`** (keep existing lines):

```
# Jumpseller OAuth app (from the Apps section of the Jumpseller admin)
JUMPSELLER_APP_ID=""
JUMPSELLER_APP_SECRET=""
# Public base URL of this connector (the Codespaces forwarded URL). redirect_uri = ${APP_URL}/oauth/callback
APP_URL="https://example.app.github.dev"
# 32-byte key as 64 hex chars. Generate: openssl rand -hex 32
TOKEN_ENCRYPTION_KEY=""
# LoyaltyOS (self-hosted)
LOYALTYOS_API_URL="http://localhost:3002"
LOYALTYOS_API_KEY="dev-key"
LOYALTYOS_PROGRAM_ID="prog_dev"
```

- [ ] **Step 8: Commit**

```bash
git add src/config.ts tests/config.test.ts .env.example package.json pnpm-lock.yaml
git commit -m "feat: add Zod-validated config module"
```

---

### Task 2: Token encryption (AES-256-GCM)

**Files:**
- Create: `src/crypto.ts`
- Test: `tests/crypto.test.ts`

- [ ] **Step 1: Write the failing test** `tests/crypto.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from '../src/crypto.js'

const key = 'a'.repeat(64) // 32 bytes hex

describe('crypto', () => {
  it('round-trips a value', () => {
    const enc = encrypt('secret-token', key)
    expect(enc).not.toContain('secret-token')
    expect(decrypt(enc, key)).toBe('secret-token')
  })

  it('produces different ciphertext each call (random IV)', () => {
    expect(encrypt('x', key)).not.toBe(encrypt('x', key))
  })

  it('fails to decrypt if the ciphertext is tampered', () => {
    const enc = encrypt('secret', key)
    const [iv, tag, data] = enc.split(':')
    const tampered = [iv, tag, Buffer.from('zzzz').toString('base64')].join(':')
    expect(() => decrypt(tampered, key)).toThrow()
  })
})
```

- [ ] **Step 2: Run `pnpm test`** → crypto tests FAIL.

- [ ] **Step 3: Implement** `src/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'

export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex')
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

export function decrypt(payload: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex')
  const [ivB64, tagB64, dataB64] = payload.split(':')
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: Run `pnpm test`** → crypto tests PASS. **Step 5: `pnpm lint`** clean.

- [ ] **Step 6: Commit**

```bash
git add src/crypto.ts tests/crypto.test.ts
git commit -m "feat: add AES-256-GCM token encryption helper"
```

---

### Task 3: Extend Install schema for token lifecycle

**Files:**
- Modify: `prisma/schema.prisma` (Install model)
- Test: `tests/db.test.ts` (extend existing test)

- [ ] **Step 1: Add two fields to the `Install` model** in `prisma/schema.prisma`. The model becomes EXACTLY:

```prisma
model Install {
  id             String   @id @default(cuid())
  storeId        String   @unique
  storeUrl       String
  accessToken    String
  refreshToken   String
  scopes         String
  tokenExpiresAt DateTime
  installedAt    DateTime @default(now())
}
```

- [ ] **Step 2: Apply to dev + regenerate client**

Run: `DATABASE_URL="file:./dev.db" pnpm prisma db push`
Expected: schema synced, client regenerated.

- [ ] **Step 3: Update `tests/db.test.ts`** to include the new required fields. Replace the `create` data block so the test reads EXACTLY:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '../src/db.js'

afterAll(async () => {
  await prisma.$disconnect()
})

describe('Install model', () => {
  it('persists and reads back an install', async () => {
    const storeId = 'store_test_1'
    await prisma.install.create({
      data: {
        storeId,
        storeUrl: 'https://x.jumpseller.com',
        accessToken: 'enc-access',
        refreshToken: 'enc-refresh',
        scopes: 'read_orders,write_promotions',
        tokenExpiresAt: new Date('2026-01-01T00:00:00Z'),
      },
    })

    const found = await prisma.install.findUnique({ where: { storeId } })
    expect(found?.storeUrl).toBe('https://x.jumpseller.com')
    expect(found?.refreshToken).toBe('enc-refresh')

    await prisma.install.delete({ where: { storeId } })
  })
})
```

- [ ] **Step 4: Run `pnpm test`** → all tests PASS (globalSetup re-pushes the new schema to `test.db`). **Step 5: `pnpm lint`** clean.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma tests/db.test.ts
git commit -m "feat: add refreshToken and tokenExpiresAt to Install"
```

---

### Task 4: OAuth helpers (authorize URL, code exchange, refresh)

**Files:**
- Create: `src/jumpseller/oauth.ts`
- Test: `tests/jumpseller/oauth.test.ts`

- [ ] **Step 1: Write the failing test** `tests/jumpseller/oauth.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildAuthorizeUrl, exchangeCode, refreshAccessToken, type OAuthAppConfig } from '../../src/jumpseller/oauth.js'

const app: OAuthAppConfig = {
  appId: 'cid',
  appSecret: 'csecret',
  redirectUri: 'https://x.dev/oauth/callback',
  scopes: 'read_orders read_store',
}

function tokenResponse() {
  return new Response(
    JSON.stringify({
      access_token: 'at',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: 'rt',
      created_at: 1_700_000_000,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('buildAuthorizeUrl', () => {
  it('includes client_id, redirect_uri, response_type, scope, state', () => {
    const url = new URL(buildAuthorizeUrl(app, 'st8'))
    expect(url.origin + url.pathname).toBe('https://accounts.jumpseller.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://x.dev/oauth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('read_orders read_store')
    expect(url.searchParams.get('state')).toBe('st8')
  })
})

describe('exchangeCode', () => {
  it('posts the code and returns a TokenSet with computed expiry', async () => {
    const fetchFn = vi.fn().mockResolvedValue(tokenResponse())
    const tokens = await exchangeCode(app, 'the-code', fetchFn as unknown as typeof fetch)
    expect(fetchFn).toHaveBeenCalledWith('https://accounts.jumpseller.com/oauth/token', expect.objectContaining({ method: 'POST' }))
    const body = (fetchFn.mock.calls[0][1] as { body: URLSearchParams }).body
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('client_secret')).toBe('csecret')
    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
    expect(tokens.expiresAt.getTime()).toBe((1_700_000_000 + 3600) * 1000)
  })

  it('throws on non-200', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }))
    await expect(exchangeCode(app, 'c', fetchFn as unknown as typeof fetch)).rejects.toThrow(/401/)
  })
})

describe('refreshAccessToken', () => {
  it('posts grant_type=refresh_token', async () => {
    const fetchFn = vi.fn().mockResolvedValue(tokenResponse())
    await refreshAccessToken(app, 'old-rt', fetchFn as unknown as typeof fetch)
    const body = (fetchFn.mock.calls[0][1] as { body: URLSearchParams }).body
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-rt')
  })
})
```

- [ ] **Step 2: Run `pnpm test`** → oauth tests FAIL.

- [ ] **Step 3: Implement** `src/jumpseller/oauth.ts`:

```ts
const ACCOUNTS_BASE = 'https://accounts.jumpseller.com'

export interface OAuthAppConfig {
  appId: string
  appSecret: string
  redirectUri: string
  scopes: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: Date
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  created_at: number
}

function toTokenSet(json: TokenResponse): TokenSet {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date((json.created_at + json.expires_in) * 1000),
  }
}

export function buildAuthorizeUrl(app: OAuthAppConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: app.redirectUri,
    response_type: 'code',
    scope: app.scopes,
    state,
  })
  return `${ACCOUNTS_BASE}/oauth/authorize?${params.toString()}`
}

async function postToken(body: URLSearchParams, fetchFn: typeof fetch): Promise<TokenSet> {
  const res = await fetchFn(`${ACCOUNTS_BASE}/oauth/token`, { method: 'POST', body })
  if (!res.ok) throw new Error(`Jumpseller token request failed: ${res.status}`)
  return toTokenSet((await res.json()) as TokenResponse)
}

export function exchangeCode(app: OAuthAppConfig, code: string, fetchFn: typeof fetch = fetch): Promise<TokenSet> {
  return postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: app.appId,
      client_secret: app.appSecret,
      redirect_uri: app.redirectUri,
    }),
    fetchFn,
  )
}

export function refreshAccessToken(app: OAuthAppConfig, refreshToken: string, fetchFn: typeof fetch = fetch): Promise<TokenSet> {
  return postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: app.appId,
      client_secret: app.appSecret,
    }),
    fetchFn,
  )
}
```

- [ ] **Step 4: Run `pnpm test`** → oauth tests PASS. **Step 5: `pnpm lint`** clean.

- [ ] **Step 6: Commit**

```bash
git add src/jumpseller/oauth.ts tests/jumpseller/oauth.test.ts
git commit -m "feat: add Jumpseller OAuth helpers (authorize, exchange, refresh)"
```

---

### Task 5: Install repository (encrypted persistence + auto-refresh)

**Files:**
- Create: `src/installs.ts`
- Test: `tests/installs.test.ts`

- [ ] **Step 1: Write the failing test** `tests/installs.test.ts`:

```ts
import { describe, it, expect, vi, afterAll } from 'vitest'
import { saveInstall, getValidAccessToken } from '../src/installs.js'
import { prisma } from '../src/db.js'
import type { OAuthAppConfig } from '../src/jumpseller/oauth.js'

const KEY = 'b'.repeat(64)
const app: OAuthAppConfig = { appId: 'c', appSecret: 's', redirectUri: 'https://x/cb', scopes: 'read_store' }

afterAll(async () => {
  await prisma.$disconnect()
})

function tokenResponse(at: string, rt: string) {
  return new Response(
    JSON.stringify({ access_token: at, refresh_token: rt, expires_in: 3600, created_at: 1_700_000_000 }),
    { status: 200 },
  )
}

describe('saveInstall + getValidAccessToken', () => {
  it('stores tokens encrypted (not plaintext) and returns the access token when valid', async () => {
    const storeId = 'store_inst_valid'
    const future = new Date(Date.now() + 3_600_000)
    await saveInstall({ storeId, storeUrl: 'https://s.jumpseller.com', scopes: 'read_store', tokens: { accessToken: 'plain-at', refreshToken: 'plain-rt', expiresAt: future } }, KEY)

    const row = await prisma.install.findUniqueOrThrow({ where: { storeId } })
    expect(row.accessToken).not.toBe('plain-at') // encrypted at rest

    const fetchFn = vi.fn() // must NOT be called when token is still valid
    const token = await getValidAccessToken(storeId, app, KEY, fetchFn as unknown as typeof fetch)
    expect(token).toBe('plain-at')
    expect(fetchFn).not.toHaveBeenCalled()

    await prisma.install.delete({ where: { storeId } })
  })

  it('refreshes and persists new tokens when the stored token is expired', async () => {
    const storeId = 'store_inst_expired'
    const past = new Date(Date.now() - 1000)
    await saveInstall({ storeId, storeUrl: 'https://s.jumpseller.com', scopes: 'read_store', tokens: { accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: past } }, KEY)

    const fetchFn = vi.fn().mockResolvedValue(tokenResponse('new-at', 'new-rt'))
    const token = await getValidAccessToken(storeId, app, KEY, fetchFn as unknown as typeof fetch)
    expect(token).toBe('new-at')
    expect(fetchFn).toHaveBeenCalledOnce()

    const row = await prisma.install.findUniqueOrThrow({ where: { storeId } })
    expect(row.tokenExpiresAt.getTime()).toBe((1_700_000_000 + 3600) * 1000)

    await prisma.install.delete({ where: { storeId } })
  })
})
```

- [ ] **Step 2: Run `pnpm test`** → installs tests FAIL.

- [ ] **Step 3: Implement** `src/installs.ts`:

```ts
import { prisma } from './db.js'
import { encrypt, decrypt } from './crypto.js'
import { refreshAccessToken, type OAuthAppConfig, type TokenSet } from './jumpseller/oauth.js'

export interface InstallInput {
  storeId: string
  storeUrl: string
  scopes: string
  tokens: TokenSet
}

const EXPIRY_SKEW_MS = 60_000

export async function saveInstall(input: InstallInput, keyHex: string): Promise<void> {
  const data = {
    storeUrl: input.storeUrl,
    scopes: input.scopes,
    accessToken: encrypt(input.tokens.accessToken, keyHex),
    refreshToken: encrypt(input.tokens.refreshToken, keyHex),
    tokenExpiresAt: input.tokens.expiresAt,
  }
  await prisma.install.upsert({
    where: { storeId: input.storeId },
    create: { storeId: input.storeId, ...data },
    update: data,
  })
}

export async function getValidAccessToken(
  storeId: string,
  app: OAuthAppConfig,
  keyHex: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const install = await prisma.install.findUnique({ where: { storeId } })
  if (!install) throw new Error(`No install found for store ${storeId}`)

  if (install.tokenExpiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS) {
    return decrypt(install.accessToken, keyHex)
  }

  const refreshed = await refreshAccessToken(app, decrypt(install.refreshToken, keyHex), fetchFn)
  await prisma.install.update({
    where: { storeId },
    data: {
      accessToken: encrypt(refreshed.accessToken, keyHex),
      refreshToken: encrypt(refreshed.refreshToken, keyHex),
      tokenExpiresAt: refreshed.expiresAt,
    },
  })
  return refreshed.accessToken
}
```

- [ ] **Step 4: Run `pnpm test`** → installs tests PASS. **Step 5: `pnpm lint`** clean.

- [ ] **Step 6: Commit**

```bash
git add src/installs.ts tests/installs.test.ts
git commit -m "feat: add install repository with encrypted tokens and auto-refresh"
```

---

### Task 6: Jumpseller API client (Bearer; store info, hooks, jsapps)

**Files:**
- Create: `src/jumpseller/client.ts`
- Test: `tests/jumpseller/client.test.ts`

- [ ] **Step 1: Write the failing test** `tests/jumpseller/client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { JumpsellerClient } from '../../src/jumpseller/client.js'

describe('JumpsellerClient', () => {
  it('getStoreInfo unwraps the store object and sends a Bearer header', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ store: { code: 'mystore', name: 'My Store', url: 'https://mystore.jumpseller.com', currency: 'CLP' } }), { status: 200 }),
    )
    const client = new JumpsellerClient('tok123', fetchFn as unknown as typeof fetch)
    const store = await client.getStoreInfo()
    expect(store.code).toBe('mystore')
    const [url, opts] = fetchFn.mock.calls[0]
    expect(url).toBe('https://api.jumpseller.com/v1/store/info.json')
    expect((opts as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok123')
  })

  it('registerHook posts {hook:{event,url}} and returns the hook id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ hook: { id: 42, event: 'order_paid', url: 'https://x/wh' } }), { status: 201 }))
    const client = new JumpsellerClient('t', fetchFn as unknown as typeof fetch)
    const hook = await client.registerHook('order_paid', 'https://x/wh')
    expect(hook.id).toBe(42)
    const [url, opts] = fetchFn.mock.calls[0]
    expect(url).toBe('https://api.jumpseller.com/v1/hooks.json')
    expect(JSON.parse((opts as { body: string }).body)).toEqual({ hook: { event: 'order_paid', url: 'https://x/wh' } })
  })

  it('createJsApp posts {app:{url,template,element}} and returns the app id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ app: { id: 7 } }), { status: 201 }))
    const client = new JumpsellerClient('t', fetchFn as unknown as typeof fetch)
    const created = await client.createJsApp('https://x/widget.js', 'layout', 'body')
    expect(created.id).toBe(7)
    expect(JSON.parse((fetchFn.mock.calls[0][1] as { body: string }).body)).toEqual({ app: { url: 'https://x/widget.js', template: 'layout', element: 'body' } })
  })

  it('throws on a non-2xx response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('err', { status: 500 }))
    const client = new JumpsellerClient('t', fetchFn as unknown as typeof fetch)
    await expect(client.getStoreInfo()).rejects.toThrow(/500/)
  })
})
```

- [ ] **Step 2: Run `pnpm test`** → client tests FAIL.

- [ ] **Step 3: Implement** `src/jumpseller/client.ts`:

```ts
const API_BASE = 'https://api.jumpseller.com/v1'

export interface StoreInfo {
  code: string
  name: string
  url: string
  currency: string
}

export interface HookResult {
  id: number
}

export interface JsAppResult {
  id: number
}

export class JumpsellerClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Jumpseller API ${method} ${path} failed: ${res.status}`)
    return (await res.json()) as T
  }

  async getStoreInfo(): Promise<StoreInfo> {
    const json = await this.request<{ store: StoreInfo }>('GET', '/store/info.json')
    return json.store
  }

  async registerHook(event: string, url: string): Promise<HookResult> {
    const json = await this.request<{ hook: HookResult }>('POST', '/hooks.json', { hook: { event, url } })
    return json.hook
  }

  async createJsApp(url: string, template: string, element: string): Promise<JsAppResult> {
    const json = await this.request<{ app: JsAppResult }>('POST', '/jsapps.json', { app: { url, template, element } })
    return json.app
  }
}
```

- [ ] **Step 4: Run `pnpm test`** → client tests PASS. **Step 5: `pnpm lint`** clean.

- [ ] **Step 6: Commit**

```bash
git add src/jumpseller/client.ts tests/jumpseller/client.test.ts
git commit -m "feat: add Jumpseller API client (store info, hooks, jsapps)"
```

---

### Task 7: OAuth routes + server wiring

**Files:**
- Create: `src/oauth-state.ts`
- Test: `tests/oauth-state.test.ts`
- Create: `src/routes/oauth.ts`
- Test: `tests/routes/oauth.test.ts`
- Modify: `src/server.ts` (accept optional oauth deps)
- Modify: `src/index.ts` (load config, wire deps, dotenv)

- [ ] **Step 1: Write the failing test** `tests/oauth-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createState, consumeState } from '../src/oauth-state.js'

describe('oauth-state', () => {
  it('accepts a freshly created state exactly once', () => {
    createState('abc')
    expect(consumeState('abc')).toBe(true)
    expect(consumeState('abc')).toBe(false) // single-use
  })

  it('rejects an unknown state', () => {
    expect(consumeState('never-created')).toBe(false)
  })
})
```

- [ ] **Step 2: Implement** `src/oauth-state.ts`:

```ts
// Single-process, in-memory CSRF state store for the OAuth flow (Phase 1).
// NOT multi-instance safe — replace with a shared store (Redis/DB) for Phase 2.
const states = new Map<string, number>()
const TTL_MS = 10 * 60 * 1000

export function createState(value: string): void {
  states.set(value, Date.now() + TTL_MS)
}

export function consumeState(value: string): boolean {
  const expiresAt = states.get(value)
  if (expiresAt === undefined) return false
  states.delete(value)
  return expiresAt > Date.now()
}
```

- [ ] **Step 3: Write the failing route test** `tests/routes/oauth.test.ts`:

```ts
import { describe, it, expect, vi, afterAll } from 'vitest'
import { buildServer } from '../../src/server.js'
import { prisma } from '../../src/db.js'
import type { OAuthRoutesDeps } from '../../src/routes/oauth.js'

afterAll(async () => {
  await prisma.$disconnect()
})

function deps(fetchFn: typeof fetch): OAuthRoutesDeps {
  return {
    app: { appId: 'cid', appSecret: 'sec', redirectUri: 'https://x.dev/oauth/callback', scopes: 'read_store' },
    encryptionKey: 'c'.repeat(64),
    appUrl: 'https://x.dev',
    fetchFn,
  }
}

describe('GET /install', () => {
  it('redirects to the Jumpseller authorize endpoint', async () => {
    const app = buildServer({ oauth: deps(vi.fn() as unknown as typeof fetch) })
    const res = await app.inject({ method: 'GET', url: '/install' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('https://accounts.jumpseller.com/oauth/authorize')
    expect(res.headers.location).toContain('client_id=cid')
    await app.close()
  })
})

describe('GET /oauth/callback', () => {
  it('rejects a request with an invalid state', async () => {
    const app = buildServer({ oauth: deps(vi.fn() as unknown as typeof fetch) })
    const res = await app.inject({ method: 'GET', url: '/oauth/callback?code=x&state=bogus' })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('exchanges the code, stores the install, and registers the order_paid hook', async () => {
    const fetchFn = vi.fn()
      // 1) token exchange
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, created_at: 1_700_000_000 }), { status: 200 }))
      // 2) GET /store/info.json
      .mockResolvedValueOnce(new Response(JSON.stringify({ store: { code: 'store_cb', name: 'S', url: 'https://store_cb.jumpseller.com', currency: 'CLP' } }), { status: 200 }))
      // 3) POST /hooks.json
      .mockResolvedValueOnce(new Response(JSON.stringify({ hook: { id: 1, event: 'order_paid', url: 'https://x.dev/webhooks/jumpseller' } }), { status: 201 }))

    const app = buildServer({ oauth: deps(fetchFn as unknown as typeof fetch) })

    // obtain a valid state by hitting /install first
    const install = await app.inject({ method: 'GET', url: '/install' })
    const state = new URL(install.headers.location as string).searchParams.get('state') as string

    const res = await app.inject({ method: 'GET', url: `/oauth/callback?code=abc&state=${state}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('connected')

    const row = await prisma.install.findUniqueOrThrow({ where: { storeId: 'store_cb' } })
    expect(row.accessToken).not.toBe('at') // encrypted

    // third fetch call registered the order_paid hook
    const hookCall = fetchFn.mock.calls[2]
    expect(hookCall[0]).toBe('https://api.jumpseller.com/v1/hooks.json')
    expect(JSON.parse((hookCall[1] as { body: string }).body)).toEqual({ hook: { event: 'order_paid', url: 'https://x.dev/webhooks/jumpseller' } })

    await prisma.install.delete({ where: { storeId: 'store_cb' } })
    await app.close()
  })
})
```

- [ ] **Step 4: Run `pnpm test`** → oauth-state passes; route tests FAIL (modules/wiring missing).

- [ ] **Step 5: Implement** `src/routes/oauth.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { buildAuthorizeUrl, exchangeCode, type OAuthAppConfig } from '../jumpseller/oauth.js'
import { JumpsellerClient } from '../jumpseller/client.js'
import { saveInstall } from '../installs.js'
import { createState, consumeState } from '../oauth-state.js'

export interface OAuthRoutesDeps {
  app: OAuthAppConfig
  encryptionKey: string
  appUrl: string
  fetchFn?: typeof fetch
}

export async function oauthRoutes(server: FastifyInstance, deps: OAuthRoutesDeps): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch

  server.get('/install', async (_req, reply) => {
    const state = randomBytes(16).toString('hex')
    createState(state)
    return reply.redirect(buildAuthorizeUrl(deps.app, state))
  })

  server.get<{ Querystring: { code?: string; state?: string } }>('/oauth/callback', async (req, reply) => {
    const { code, state } = req.query
    if (!code || !state || !consumeState(state)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const tokens = await exchangeCode(deps.app, code, fetchFn)
    const client = new JumpsellerClient(tokens.accessToken, fetchFn)
    const store = await client.getStoreInfo()

    await saveInstall({ storeId: store.code, storeUrl: store.url, scopes: deps.app.scopes, tokens }, deps.encryptionKey)
    await client.registerHook('order_paid', `${deps.appUrl}/webhooks/jumpseller`)

    return reply.type('text/html').send('<h1>LoyaltyOS connected ✓</h1><p>You can close this window.</p>')
  })
}
```

- [ ] **Step 6: Modify** `src/server.ts` to accept optional OAuth deps. Final content:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import { healthRoutes } from './routes/health.js'
import { oauthRoutes, type OAuthRoutesDeps } from './routes/oauth.js'

export interface ServerOptions {
  oauth?: OAuthRoutesDeps
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false })
  app.register(healthRoutes)
  if (opts.oauth) {
    app.register(oauthRoutes, opts.oauth)
  }
  return app
}
```

- [ ] **Step 7: Modify** `src/index.ts` to load config and wire deps. Final content:

```ts
import 'dotenv/config'
import { buildServer } from './server.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const PORT = config.PORT

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
})

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then((address) => console.log(`connector listening at ${address}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
```

- [ ] **Step 8: Run `pnpm test`** → ALL tests pass (health, config, crypto, db, oauth, installs, client, oauth-state, routes/oauth). **Step 9: `pnpm lint`** clean.

- [ ] **Step 10: Verify the health test still passes with the new `buildServer` signature** (it calls `buildServer()` with no args — must still return a working app). Confirm in the test output.

- [ ] **Step 11: Commit**

```bash
git add src/oauth-state.ts tests/oauth-state.test.ts src/routes/oauth.ts tests/routes/oauth.test.ts src/server.ts src/index.ts
git commit -m "feat: wire OAuth install + callback routes into the server"
```

---

## Self-Review

**Spec coverage (OAuth slice of the design spec §4.1):**
- OAuth authorize + callback routes → Task 7 ✓
- Token exchange + refresh (1h expiry) → Tasks 4, 5 ✓
- Encrypted token storage at rest (security-review carry-forward) → Tasks 2, 3, 5 ✓
- Persist Install keyed by store → Tasks 3, 5 ✓
- Fetch store info on install → Tasks 6, 7 ✓
- Auto-register the `order_paid` webhook → Tasks 6, 7 ✓
- CSRF `state` validation → Task 7 ✓
- *Deferred by design:* JS App creation (Plan 4, needs the widget script URL); webhook HMAC verification (Plan 3, when the receiver is built); scopes requested but only `read_store`/`write_hooks` exercised here.

**Placeholder scan:** None. Every step has complete code and exact commands.

**Type consistency:** `OAuthAppConfig`/`TokenSet` (Task 4) are consumed by `installs.ts` (Task 5), `client.ts`/`JumpsellerClient` (Task 6), and `oauth.ts` route deps (Task 7). `OAuthRoutesDeps` (Task 7, `routes/oauth.ts`) is imported by `server.ts` and the route test. `buildServer(opts)` optional-arg change keeps the Plan 1 health test (`buildServer()`) valid — checked in Step 10. `saveInstall`/`getValidAccessToken` signatures match between Task 5 impl and its test and the route caller.

**Known live-confirmation items (mocked here, verify at deploy):** response wrapping `{store}`/`{hook}`/`{app}`; the exact `store.code`/`store.url` field names from `/store/info.json`; whether hook registration needs the app installed first. These do not block building/testing this slice.
