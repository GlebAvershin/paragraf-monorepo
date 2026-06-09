/**
 * LiteLLM Management API client.
 * Used by Billing-сервис to create/update/block virtual keys for users.
 *
 * Docs: https://docs.litellm.ai/docs/proxy/virtual_keys
 */
import { config } from "../config.ts"

type Json = Record<string, unknown>

export interface CreateKeyParams {
  /** Our user.id — kept on LiteLLM side as the linkage. */
  userId: string
  /** Subscription period end — LiteLLM expires the key automatically. */
  durationDays?: number
  /** Hard budget in USD. LiteLLM blocks requests over this. */
  maxBudgetUsd: number
  /** Reset window — defaults to "30d". */
  budgetDuration?: string
  /** Whitelist of models from litellm-config.yaml. */
  models: string[]
  /** Requests per minute. */
  rpmLimit?: number
  /** Tokens per minute. */
  tpmLimit?: number
  /** Human-readable alias for the key in LiteLLM admin UI. */
  alias?: string
  /** Arbitrary metadata stored on the key. */
  metadata?: Json
}

export interface SpendLog {
  requestId: string
  apiKey: string | null
  userId: string | null
  /** Внутреннее имя модели LiteLLM (напр. "gigachat/GigaChat"). */
  model: string
  /** Алиас model_name из litellm-config (= наш model_rates.modelCode, напр. "gigachat-lite"). */
  modelGroup: string | null
  provider: string
  inputTokens: number
  outputTokens: number
  spendUsd: number
  startedAt: string | null
  endedAt: string | null
  status: "ok" | "failure"
}

export interface KeyInfo {
  /** Raw spend in USD. */
  spend: number
  /** Allotted budget in USD. */
  maxBudget: number | null
  /** When LiteLLM next resets the spend (ISO). */
  budgetResetAt: string | null
  models: string[]
  expiresAt: string | null
  blocked: boolean
}

export class LiteLLMError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message)
    this.name = "LiteLLMError"
  }
}

class LiteLLMClient {
  constructor(
    private baseUrl: string,
    private masterKey: string,
  ) {}

  private async request<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Json,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.masterKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }

    if (!res.ok) {
      throw new LiteLLMError(
        `LiteLLM ${method} ${path} failed: ${res.status}`,
        res.status,
        parsed,
      )
    }
    return parsed as T
  }

  /**
   * Create a new virtual key. Returns the sk-... key to give to the client.
   */
  async createKey(params: CreateKeyParams): Promise<{ key: string }> {
    const body: Json = {
      user_id: params.userId,
      max_budget: params.maxBudgetUsd,
      budget_duration: params.budgetDuration ?? "30d",
      models: params.models,
    }
    if (params.durationDays !== undefined) body.duration = `${params.durationDays}d`
    if (params.rpmLimit !== undefined) body.rpm_limit = params.rpmLimit
    if (params.tpmLimit !== undefined) body.tpm_limit = params.tpmLimit
    if (params.alias) body.key_alias = params.alias
    if (params.metadata) body.metadata = params.metadata

    const resp = await this.request<{ key: string }>("POST", "/key/generate", body)
    if (!resp.key) {
      throw new LiteLLMError("Response missing key", 500, resp)
    }
    return { key: resp.key }
  }

  /**
   * Update an existing key (plan change, renewal, budget reset).
   */
  async updateKey(
    key: string,
    params: Partial<Pick<CreateKeyParams, "maxBudgetUsd" | "models" | "rpmLimit" | "tpmLimit">>,
  ): Promise<void> {
    const body: Json = { key }
    if (params.maxBudgetUsd !== undefined) body.max_budget = params.maxBudgetUsd
    if (params.models !== undefined) body.models = params.models
    if (params.rpmLimit !== undefined) body.rpm_limit = params.rpmLimit
    if (params.tpmLimit !== undefined) body.tpm_limit = params.tpmLimit
    await this.request("POST", "/key/update", body)
  }

  /**
   * Block (soft-disable) a key. Used on subscription expiration.
   */
  async blockKey(key: string): Promise<void> {
    await this.request("POST", "/key/block", { key })
  }

  /**
   * Unblock a key. Used on reactivation.
   */
  async unblockKey(key: string): Promise<void> {
    await this.request("POST", "/key/unblock", { key })
  }

  /**
   * Permanently delete a key.
   */
  async deleteKey(key: string): Promise<void> {
    await this.request("POST", "/key/delete", { keys: [key] })
  }

  /**
   * Fetch spend logs (for ETL credit-charging worker).
   * Returns request-level usage records with model, tokens, cost.
   *
   * Docs: https://docs.litellm.ai/docs/proxy/cost_tracking#querying-spend
   */
  async getSpendLogs(params: {
    /** ISO date or "YYYY-MM-DD". Inclusive. */
    startDate?: string
    /** ISO date or "YYYY-MM-DD". Inclusive. */
    endDate?: string
    /** Filter by virtual_key — leaves us per-subscription scope. */
    apiKey?: string
    /** Pagination. */
    page?: number
    pageSize?: number
  }): Promise<SpendLog[]> {
    const qs = new URLSearchParams()
    if (params.startDate) qs.set("start_date", params.startDate)
    if (params.endDate) qs.set("end_date", params.endDate)
    if (params.apiKey) qs.set("api_key", params.apiKey)
    if (params.page !== undefined) qs.set("page", String(params.page))
    if (params.pageSize !== undefined) qs.set("page_size", String(params.pageSize))

    const query = qs.toString()
    const path = `/spend/logs${query ? `?${query}` : ""}`
    const raw = await this.request<unknown>("GET", path)
    // LiteLLM возвращает либо массив, либо объект с полем data — поддерживаем оба.
    const rows = Array.isArray(raw) ? raw : (raw as { data?: unknown[] })?.data ?? []
    return rows.map((r): SpendLog => {
      const row = r as Json
      return {
        requestId: String(row.request_id ?? row.id ?? ""),
        apiKey: (row.api_key as string | null) ?? null,
        userId: (row.user as string | null) ?? null,
        model: String(row.model ?? ""),
        modelGroup: (row.model_group as string | null) ?? null,
        provider: (row.custom_llm_provider as string | undefined) ?? "unknown",
        inputTokens: Number(row.prompt_tokens ?? row.input_tokens ?? 0),
        outputTokens: Number(row.completion_tokens ?? row.output_tokens ?? 0),
        spendUsd: Number(row.spend ?? row.cost ?? 0),
        startedAt: (row.startTime as string | undefined) ?? (row.timestamp as string | undefined) ?? null,
        endedAt: (row.endTime as string | undefined) ?? null,
        status: row.status === "failure" ? "failure" : "ok",
      }
    })
  }

  /**
   * Fetch current spend / budget / status for a key.
   * Used by /limits endpoint for the desktop UI indicator.
   */
  async getKeyInfo(key: string): Promise<KeyInfo> {
    const resp = await this.request<{ info: Json }>("GET", `/key/info?key=${encodeURIComponent(key)}`)
    const info = (resp.info ?? {}) as Json
    return {
      spend: Number(info.spend ?? 0),
      maxBudget: info.max_budget != null ? Number(info.max_budget) : null,
      budgetResetAt: (info.budget_reset_at as string | null) ?? null,
      models: (info.models as string[] | undefined) ?? [],
      expiresAt: (info.expires as string | null) ?? null,
      blocked: Boolean(info.blocked),
    }
  }
}

export const litellm = new LiteLLMClient(config.LITELLM_BASE_URL, config.LITELLM_MASTER_KEY)
