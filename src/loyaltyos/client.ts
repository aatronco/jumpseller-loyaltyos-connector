export interface LoyaltyOsConfig {
  apiUrl: string
  apiKey: string
  programId: string
}

export interface LoyaltyMember {
  id: string
  email?: string
}

export interface MemberBalance {
  confirmed: number
  pending: number
  total: number
}

export interface Reward {
  id: string
  name?: string
  isActive: boolean
  pointsCost: number
  stock: number | null
  description?: string | null
  metadata?: Record<string, unknown>
}

export interface RedeemResult {
  redemption: { id: string; rewardId: string; memberId: string; pointsSpent: number }
}

export interface PurchaseEvent {
  memberId: string
  amount: number
  currency: string
  orderId: string
  idempotencyKey: string
}

export class LoyaltyOsClient {
  constructor(
    private readonly cfg: LoyaltyOsConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; extraHeaders?: Record<string, string> } = {},
  ): Promise<T> {
    const res = await this.fetchFn(`${this.cfg.apiUrl}${path}`, {
      method,
      headers: {
        'X-API-Key': this.cfg.apiKey,
        'X-Program-Id': this.cfg.programId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...opts.extraHeaders,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    if (!res.ok) throw new Error(`LoyaltyOS ${method} ${path} failed: ${res.status}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : {}) as T
  }

  async findMemberByEmail(email: string): Promise<LoyaltyMember | null> {
    const json = await this.request<{ data: { items: LoyaltyMember[] } }>(
      'GET',
      `/api/v1/members?search=${encodeURIComponent(email)}`,
    )
    // search is contains-match over several fields; require an exact email match
    const exact = json.data.items.find((m) => m.email?.toLowerCase() === email.toLowerCase())
    return exact ?? null
  }

  async createMember(email: string): Promise<LoyaltyMember> {
    const json = await this.request<{ data: LoyaltyMember }>('POST', '/api/v1/members', {
      body: { email },
    })
    return json.data
  }

  async ensureMember(email: string): Promise<LoyaltyMember> {
    return (await this.findMemberByEmail(email)) ?? (await this.createMember(email))
  }

  async getMemberBalance(memberId: string): Promise<MemberBalance> {
    const json = await this.request<{ data: MemberBalance }>(
      'GET',
      `/api/v1/members/${encodeURIComponent(memberId)}/balance`,
    )
    return json.data
  }

  async listRewards(): Promise<Reward[]> {
    const json = await this.request<{ data: { items: Reward[] } }>('GET', '/api/v1/rewards')
    return json.data.items
  }

  async getReward(rewardId: string): Promise<Reward> {
    const json = await this.request<{ data: Reward }>(
      'GET',
      `/api/v1/rewards/${encodeURIComponent(rewardId)}`,
    )
    return json.data
  }

  async redeemReward(p: { rewardId: string; memberId: string; idempotencyKey: string }): Promise<RedeemResult> {
    const json = await this.request<{ data: RedeemResult }>(
      'POST',
      `/api/v1/rewards/${encodeURIComponent(p.rewardId)}/redeem`,
      { body: { rewardId: p.rewardId, memberId: p.memberId, idempotencyKey: p.idempotencyKey } },
    )
    return json.data
  }

  async recordPurchase(p: PurchaseEvent): Promise<void> {
    await this.request('POST', '/api/v1/events', {
      body: {
        type: 'purchase',
        memberId: p.memberId,
        payload: { amount: p.amount, currency: p.currency, orderId: p.orderId },
      },
      extraHeaders: { 'Idempotency-Key': p.idempotencyKey },
    })
  }

  async createReward(input: {
    name: string
    description: string
    pointsCost: number
    stock: number
  }): Promise<Reward> {
    const json = await this.request<{ data: Reward }>('POST', '/admin/rewards', { body: input })
    return json.data
  }

  async updateReward(
    id: string,
    input: Partial<{ name: string; description: string; pointsCost: number; stock: number }>,
  ): Promise<Reward> {
    const json = await this.request<{ data: Reward }>(
      'PATCH',
      `/admin/rewards/${encodeURIComponent(id)}`,
      { body: input },
    )
    return json.data
  }

  async deleteReward(id: string): Promise<void> {
    await this.request('DELETE', `/admin/rewards/${encodeURIComponent(id)}`)
  }

  async listAllRewards(): Promise<Reward[]> {
    const json = await this.request<{ data: { items: Reward[] } }>('GET', '/admin/rewards')
    return json.data.items
  }
}
