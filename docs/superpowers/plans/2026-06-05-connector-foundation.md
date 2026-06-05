# Connector Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the connector's project skeleton — a runnable Fastify+TypeScript service with a health endpoint, a Prisma/SQLite data layer (the 5 models from the spec), a GitHub Codespaces devcontainer, and green CI on GitHub Actions.

**Architecture:** A single Node ESM service. `buildServer()` returns a configured Fastify instance (testable via `app.inject()`, no port binding); `index.ts` is the entrypoint that listens. Prisma talks to a local SQLite file. The devcontainer reproduces the environment in Codespaces with Docker-in-Docker (for LoyaltyOS later) and forwards port 3001.

**Tech Stack:** Node 20, Fastify 4, TypeScript (ESM), Zod, Prisma + SQLite, Vitest, ESLint + Prettier, GitHub Actions, GitHub Codespaces.

> **Note on testing:** the design spec mentions Supertest, but this plan uses Fastify's built-in `app.inject()` — it is the idiomatic Fastify approach, needs no running server or open port, and keeps tests fast. Same coverage, fewer moving parts.

---

### Task 1: Toolchain & package manifest

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.prettierrc`
- Create: `eslint.config.js`
- Create: `.env.example`

- [ ] **Step 1: Enable pnpm via corepack**

Run: `corepack enable && corepack prepare pnpm@9.12.0 --activate`
Expected: `pnpm -v` prints `9.12.0`.

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "jumpseller-loyaltyos-connector",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "format": "prettier --write .",
    "prisma:generate": "prisma generate",
    "prisma:push": "prisma db push"
  },
  "dependencies": {
    "@prisma/client": "^5.22.0",
    "fastify": "^4.28.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@eslint/js": "^9.13.0",
    "@types/node": "^20.16.0",
    "eslint": "^9.13.0",
    "prettier": "^3.3.3",
    "prisma": "^5.22.0",
    "tsx": "^4.19.1",
    "typescript": "^5.6.3",
    "typescript-eslint": "^8.10.0",
    "vitest": "^2.1.3"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

> The DB `env` + `globalSetup` are intentionally **not** here yet — they depend on the Prisma
> schema and `tests/setup/global-setup.ts`, both created in Task 3. Wiring them now would break
> Task 2's `pnpm test` (vitest loads `globalSetup` before any test, and the file wouldn't exist).
> Task 3 adds them.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
```

- [ ] **Step 5: Create `.prettierrc`** (matches LoyaltyOS conventions)

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "semi": false
}
```

- [ ] **Step 6: Create `eslint.config.js`**

```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'prisma/*.db', '**/*.db'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
```

- [ ] **Step 7: Create `.env.example`**

```
# Local SQLite database
DATABASE_URL="file:./prisma/dev.db"
# Connector HTTP port
PORT=3001
```

- [ ] **Step 8: Install dependencies**

Run: `pnpm install`
Expected: completes, creates `pnpm-lock.yaml` and `node_modules/`.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .prettierrc eslint.config.js .env.example pnpm-lock.yaml
git commit -m "chore: scaffold toolchain (pnpm, fastify, prisma, vitest, eslint)"
```

---

### Task 2: Fastify server factory + health route (TDD)

**Files:**
- Test: `tests/health.test.ts`
- Create: `src/server.ts`
- Create: `src/routes/health.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Write the failing test**

`tests/health.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { buildServer } from '../src/server.js'

const app = buildServer()
afterAll(async () => {
  await app.close()
})

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../src/server.js` (module does not exist yet).

- [ ] **Step 3: Implement the health route**

`src/routes/health.ts`:

```ts
import type { FastifyInstance } from 'fastify'

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }))
}
```

- [ ] **Step 4: Implement the server factory**

`src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import { healthRoutes } from './routes/health.js'

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false })
  app.register(healthRoutes)
  return app
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS — 1 test passing.

- [ ] **Step 6: Create the entrypoint**

`src/index.ts`:

```ts
import { buildServer } from './server.js'

const PORT = Number(process.env.PORT ?? 3001)

const app = buildServer()
app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then((address) => console.log(`connector listening at ${address}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
```

- [ ] **Step 7: Smoke-test the running server**

Run: `pnpm dev` (in one terminal), then `curl -s localhost:3001/health`
Expected: `{"status":"ok"}`. Stop with Ctrl-C.

- [ ] **Step 8: Commit**

```bash
git add tests/health.test.ts src/server.ts src/routes/health.ts src/index.ts
git commit -m "feat: add Fastify server factory and /health route"
```

---

### Task 3: Prisma schema + SQLite data layer (TDD)

**Files:**
- Create: `prisma/schema.prisma`
- Create: `src/db.ts`
- Create: `tests/setup/global-setup.ts`
- Test: `tests/db.test.ts`
- Modify: `.gitignore` (already ignores `*.db`)

- [ ] **Step 1: Create the Prisma schema (5 models from the spec)**

`prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Install {
  id          String   @id @default(cuid())
  storeId     String   @unique
  storeUrl    String
  accessToken String
  scopes      String
  installedAt DateTime @default(now())
}

model MemberMap {
  id                   String @id @default(cuid())
  storeId              String
  jumpsellerCustomerId String
  email                String
  loyaltyMemberId      String

  @@unique([storeId, jumpsellerCustomerId])
}

model ProcessedWebhook {
  id          String   @id @default(cuid())
  storeId     String
  eventId     String
  processedAt DateTime @default(now())

  @@unique([storeId, eventId])
}

model Redemption {
  id         String   @id @default(cuid())
  storeId    String
  memberId   String
  rewardId   String
  couponCode String
  status     String
  createdAt  DateTime @default(now())
}

model DeadLetter {
  id        String   @id @default(cuid())
  storeId   String
  payload   String
  error     String
  attempts  Int      @default(0)
  createdAt DateTime @default(now())
}
```

- [ ] **Step 2: Generate the Prisma client and create the dev DB**

Run: `DATABASE_URL="file:./prisma/dev.db" pnpm prisma db push`
Expected: "Your database is now in sync with your Prisma schema." and the Prisma client is generated.

- [ ] **Step 3: Create the Prisma singleton**

`src/db.ts`:

```ts
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()
```

- [ ] **Step 4: Create the test DB global setup**

`tests/setup/global-setup.ts`:

```ts
import { execSync } from 'node:child_process'

export default function setup(): void {
  execSync('pnpm exec prisma db push --skip-generate --force-reset', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'file:./prisma/test.db' },
  })
}
```

- [ ] **Step 5: Wire the test DB into `vitest.config.ts`**

Now that the schema and `global-setup.ts` exist, update `vitest.config.ts` to point tests at a
dedicated test DB and run the setup before the suite:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: { DATABASE_URL: 'file:./prisma/test.db' },
    globalSetup: './tests/setup/global-setup.ts',
  },
})
```

- [ ] **Step 6: Write the failing data-layer test**

`tests/db.test.ts`:

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
        accessToken: 'token-abc',
        scopes: 'read_orders,write_promotions',
      },
    })

    const found = await prisma.install.findUnique({ where: { storeId } })
    expect(found?.storeUrl).toBe('https://x.jumpseller.com')

    await prisma.install.delete({ where: { storeId } })
  })
})
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — both `health` and `Install model` tests green. (`global-setup` resets `prisma/test.db` first.)

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma src/db.ts tests/setup/global-setup.ts tests/db.test.ts vitest.config.ts
git commit -m "feat: add Prisma SQLite data layer with the 5 connector models"
```

---

### Task 4: GitHub Codespaces devcontainer

**Files:**
- Create: `.devcontainer/devcontainer.json`

- [ ] **Step 1: Create the devcontainer config**

`.devcontainer/devcontainer.json`:

```json
{
  "name": "jumpseller-loyaltyos-connector",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:1-20-bookworm",
  "features": {
    "ghcr.io/devcontainers/features/docker-in-docker:2": {}
  },
  "forwardPorts": [3001, 3002],
  "portsAttributes": {
    "3001": { "label": "connector" },
    "3002": { "label": "loyaltyos-api" }
  },
  "postCreateCommand": "corepack enable && pnpm install && pnpm exec prisma generate",
  "customizations": {
    "vscode": {
      "extensions": ["esbenp.prettier-vscode", "dbaeumer.vscode-eslint", "Prisma.prisma"]
    }
  }
}
```

- [ ] **Step 2: Document the manual port-visibility step**

> Codespaces does **not** let `devcontainer.json` set a port to public visibility (security). After the Codespace starts, run once:
> `gh codespace ports visibility 3001:public -c $CODESPACE_NAME`
> (or right-click port 3001 in the Ports panel → Port Visibility → Public). This gives the stable `*.app.github.dev` URL used for the OAuth callback and webhooks in later plans.

Add this note to the project README under a new "Running in Codespaces" section.

- [ ] **Step 3: Commit**

```bash
git add .devcontainer/devcontainer.json README.md
git commit -m "chore: add Codespaces devcontainer (node 20, docker-in-docker, port forwarding)"
```

---

### Task 5: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec prisma generate
      - run: pnpm lint
      - run: pnpm test
```

- [ ] **Step 2: Verify lint and tests pass locally before pushing**

Run: `pnpm lint && pnpm test`
Expected: lint reports no errors; all tests pass.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run lint and tests on push and PR"
git push origin main
```

- [ ] **Step 4: Verify the run is green on GitHub**

Run: `gh run watch` (or `gh run list --limit 1`)
Expected: the `CI` workflow completes with conclusion `success`.

---

## Self-Review

**Spec coverage (Phase 1 foundation slice):**
- Connector stack Node+Fastify+TS+Zod → Tasks 1–2 ✓
- Stateful, SQLite via Prisma, 5 models (`Install`, `MemberMap`, `ProcessedWebhook`, `Redemption`, `DeadLetter`) → Task 3 ✓
- Connector on port 3001 → Task 2 (`index.ts`) ✓
- GitHub Codespaces dev/demo environment + port forwarding → Task 4 ✓
- GitHub Actions CI (lint + tests) → Task 5 ✓
- Vitest testing → Tasks 2–3 ✓ (using `app.inject()`; deviation from Supertest noted in header)
- *Deferred to later plans (by design):* OAuth (Plan 2), earn/webhook (Plan 3), widget (Plan 4), redeem (Plan 5). These need exact external API shapes, confirmed before each plan is written.

**Placeholder scan:** No TBD/TODO; every code and command step is complete.

**Type consistency:** `buildServer()` defined in Task 2 and used in Task 2's test. `prisma` singleton defined in Task 3 (`src/db.ts`) and used in Task 3's test. Prisma model/field names in Task 3's test (`install`, `storeId`, `storeUrl`, `accessToken`, `scopes`) match the schema exactly.
