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
    const json = await this.request<{ app: JsAppResult }>('POST', '/jsapps.json', {
      app: { url, template, element },
    })
    return json.app
  }
}
