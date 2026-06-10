import { describe, it, expect, vi } from 'vitest'
import { LoyaltyOsClient } from '../../src/loyaltyos/client.js'

const cfg = { apiUrl: 'http://localhost:3002', apiKey: 'dev-key', programId: 'prog_dev' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('LoyaltyOsClient', () => {
  it('findMemberByEmail filters search results to an exact (case-insensitive) email match', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          { id: 'm1', email: 'other-ana@x.com' }, // contains-match noise
          { id: 'm2', email: 'Ana@X.com' },
        ],
        total: 2,
      }),
    )
    const client = new LoyaltyOsClient(cfg, fetchFn as unknown as typeof fetch)
    const member = await client.findMemberByEmail('ana@x.com')
    expect(member?.id).toBe('m2')

    const [url, opts] = fetchFn.mock.calls[0]
    expect(url).toBe('http://localhost:3002/api/v1/members?search=ana%40x.com')
    const headers = (opts as { headers: Record<string, string> }).headers
    expect(headers['X-API-Key']).toBe('dev-key')
    expect(headers['X-Program-Id']).toBe('prog_dev')
  })

  it('findMemberByEmail returns null when no exact match exists', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ items: [{ id: 'm1', email: 'nope@x.com' }], total: 1 }))
    const client = new LoyaltyOsClient(cfg, fetchFn as unknown as typeof fetch)
    expect(await client.findMemberByEmail('ana@x.com')).toBeNull()
  })

  it('createMember posts the email and unwraps {data}', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { id: 'new1', email: 'ana@x.com' } }, 201))
    const client = new LoyaltyOsClient(cfg, fetchFn as unknown as typeof fetch)
    const member = await client.createMember('ana@x.com')
    expect(member.id).toBe('new1')
    const [url, opts] = fetchFn.mock.calls[0]
    expect(url).toBe('http://localhost:3002/api/v1/members')
    expect(JSON.parse((opts as { body: string }).body)).toEqual({ email: 'ana@x.com' })
  })

  it('ensureMember returns the existing member without creating', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ items: [{ id: 'm9', email: 'a@b.c' }], total: 1 }))
    const client = new LoyaltyOsClient(cfg, fetchFn as unknown as typeof fetch)
    const member = await client.ensureMember('a@b.c')
    expect(member.id).toBe('m9')
    expect(fetchFn).toHaveBeenCalledTimes(1) // search only, no create
  })

  it('ensureMember creates when the member does not exist', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], total: 0 }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'created1' } }, 201))
    const client = new LoyaltyOsClient(cfg, fetchFn as unknown as typeof fetch)
    const member = await client.ensureMember('a@b.c')
    expect(member.id).toBe('created1')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('recordPurchase posts the event with the Idempotency-Key header', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: {} }, 201))
    const client = new LoyaltyOsClient(cfg, fetchFn as unknown as typeof fetch)
    await client.recordPurchase({ memberId: 'm1', amount: 99.5, currency: 'CLP', orderId: '1026', idempotencyKey: 'store:order_paid:1026' })
    const [url, opts] = fetchFn.mock.calls[0]
    expect(url).toBe('http://localhost:3002/api/v1/events')
    const headers = (opts as { headers: Record<string, string> }).headers
    expect(headers['Idempotency-Key']).toBe('store:order_paid:1026')
    expect(JSON.parse((opts as { body: string }).body)).toEqual({
      type: 'purchase',
      memberId: 'm1',
      payload: { amount: 99.5, currency: 'CLP', orderId: '1026' },
    })
  })

  it('getMemberBalance unwraps {data} from the balance route', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { confirmed: 120, pending: 30, total: 150 } }))
    const client = new LoyaltyOsClient(cfg, fetchFn as unknown as typeof fetch)
    const balance = await client.getMemberBalance('m1')
    expect(balance).toEqual({ confirmed: 120, pending: 30, total: 150 })
    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:3002/api/v1/members/m1/balance')
  })

  it('throws on a non-2xx response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    const client = new LoyaltyOsClient(cfg, fetchFn as unknown as typeof fetch)
    await expect(client.findMemberByEmail('a@b.c')).rejects.toThrow(/500/)
  })
})
