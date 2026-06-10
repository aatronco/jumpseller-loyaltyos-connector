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

export interface CouponInput {
  code: string
  type: 'fixed' | 'percent'
  value: number
}

export interface PromotionResult {
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
    const text = await res.text()
    return (text ? JSON.parse(text) : {}) as T
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

  async createDiscountCoupon(input: CouponInput): Promise<PromotionResult> {
    const discountField =
      input.type === 'percent'
        ? { discount_amount_percent: input.value }
        : { discount_amount_fix: input.value }
    const json = await this.request<{ promotion: PromotionResult }>('POST', '/promotions.json', {
      promotion: {
        name: `LoyaltyOS reward ${input.code}`,
        discount_target: 'order',
        ...discountField,
        lasts: 'max_times_used',
        max_times_used: 1,
        cumulative: false,
        coupons: [{ code: input.code, usage_limit: 1 }],
      },
    })
    return json.promotion
  }
}
