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
