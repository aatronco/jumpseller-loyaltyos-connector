import { describe, it, expect, vi } from 'vitest'
import { JumpsellerClient } from '../../src/jumpseller/client.js'

describe('JumpsellerClient', () => {
  it('getStoreInfo unwraps the store object and sends a Bearer header', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          store: { code: 'mystore', name: 'My Store', url: 'https://mystore.jumpseller.com', currency: 'CLP' },
        }),
        { status: 200 },
      ),
    )
    const client = new JumpsellerClient('tok123', fetchFn as unknown as typeof fetch)
    const store = await client.getStoreInfo()
    expect(store.code).toBe('mystore')
    const [url, opts] = fetchFn.mock.calls[0]
    expect(url).toBe('https://api.jumpseller.com/v1/store/info.json')
    expect((opts as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok123')
  })

  it('registerHook posts {hook:{event,url}} and returns the hook id', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ hook: { id: 42, event: 'order_paid', url: 'https://x/wh' } }), { status: 201 }),
      )
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
    expect(JSON.parse((fetchFn.mock.calls[0][1] as { body: string }).body)).toEqual({
      app: { url: 'https://x/widget.js', template: 'layout', element: 'body' },
    })
  })

  it('throws on a non-2xx response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('err', { status: 500 }))
    const client = new JumpsellerClient('t', fetchFn as unknown as typeof fetch)
    await expect(client.getStoreInfo()).rejects.toThrow(/500/)
  })
})
