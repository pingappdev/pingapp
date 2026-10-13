import { config } from "../env";
import type {
  ApiRequestOptions,
  Address,
  AuthorizeSendInput,
  RouterAuthorization,
  Escrow,
  SelfClaim,
  BalancesResponse,
  ClaimView,
  ConfigResponse,
  Contact,
  ContactCreateInput,
  ContactUpdateInput,
  Intent,
  IntentCreateInput,
  IntentStatusFilter,
  IncomingIntent,
  Me,
  Notification,
  NotificationReadInput,
  Page,
  ResolveResponse,
  SessionInfo,
  Token,
  Transfer,
  TransferCreateInput,
  TransferDirection,
  TransferListParams,
} from "./types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type ApiOptions = ApiRequestOptions & {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  cache?: RequestCache;
  responseType?: "blob";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function apiUrl(path: string): string {
  return `${config.apiUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    accept: opts.responseType === "blob" ? "text/csv" : "application/json",
  };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["x-pingapp"] = "1";
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      credentials: "include",
      headers,
      ...(opts.cache === undefined ? {} : { cache: opts.cache }),
      ...(method === "GET" ? {} : { body: JSON.stringify(opts.body ?? {}) }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError("NETWORK", 0, "Can't reach PingApp. Check your connection.");
  }

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      payload = undefined;
    }

    const errorPayload = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    const code = typeof errorPayload?.code === "string" ? errorPayload.code : "HTTP_ERROR";
    const message =
      typeof errorPayload?.message === "string"
        ? errorPayload.message
        : response.statusText || "The request failed. Please try again.";
    const details = isRecord(errorPayload?.details) ? errorPayload.details : undefined;
    const error = new ApiError(code, response.status, message, details);

    if (
      response.status === 401 &&
      error.code === "UNAUTHENTICATED" &&
      path.split("?", 1)[0] !== "/v1/auth/session" &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new Event("pingapp:unauthenticated"));
    }

    throw error;
  }

  return (opts.responseType === "blob" ? await response.blob() : await response.json()) as T;
}

function withQuery(path: string, values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

function mutation<T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) {
  return (options?: ApiRequestOptions) =>
    api<T>(path, { method, ...(body === undefined ? {} : { body }), ...options });
}

export const endpoints = {
  sends: {
    authorize: (input: AuthorizeSendInput, options?: ApiRequestOptions) =>
      api<RouterAuthorization>("/v1/sends/authorize", { method: "POST", body: input, ...options }),
  },
  escrows: {
    list: (role: "sent" | "incoming", options?: ApiRequestOptions) =>
      api<{ items: Escrow[] }>(withQuery("/v1/escrows", { role }), options),
    claim: (id: string, options?: ApiRequestOptions) =>
      api<{ escrow: { id: string; status: "claiming" } }>(
        `/v1/escrows/${encodeURIComponent(id)}/claim`,
        { method: "POST", ...options },
      ),
    selfClaim: (id: string, options?: ApiRequestOptions) =>
      api<{ claim: SelfClaim }>(`/v1/escrows/${encodeURIComponent(id)}/self-claim`, {
        method: "POST",
        ...options,
      }),
    submitted: (id: string, txHash: Address, options?: ApiRequestOptions) =>
      api<{ escrow: { id: string; status: string; depositTxHash: Address } }>(
        `/v1/escrows/${encodeURIComponent(id)}/submitted`,
        { method: "POST", body: { txHash }, ...options },
      ),
  },
  health: {
    get: (options?: ApiRequestOptions) =>
      api<{ ok: boolean; db: boolean; redis: boolean }>("/health", options),
  },
  auth: {
    nonce: (options?: ApiRequestOptions) => api<{ nonce: string }>("/v1/auth/nonce", options),
    verify: (message: string, signature: `0x${string}`, options?: ApiRequestOptions) =>
      api<{ me: Me }>("/v1/auth/verify", {
        method: "POST",
        body: { message, signature },
        ...options,
      }),
    session: (options?: ApiRequestOptions) => api<{ me: Me }>("/v1/auth/session", options),
    reauth: (message: string, signature: `0x${string}`, options?: ApiRequestOptions) =>
      api<{ freshUntil: string }>("/v1/auth/reauth", {
        method: "POST",
        body: { message, signature },
        ...options,
      }),
    logout: mutation<void>("/v1/auth/logout", "POST"),
  },
  me: {
    get: (options?: ApiRequestOptions) => api<{ me: Me }>("/v1/me", options),
    update: (input: { displayName: string }, options?: ApiRequestOptions) =>
      api<{ me: Me }>("/v1/me", { method: "PATCH", body: input, ...options }),
    sessions: (options?: ApiRequestOptions) =>
      api<{ items: SessionInfo[] }>("/v1/me/sessions", options),
    revokeSession: (id: string, options?: ApiRequestOptions) =>
      api<void>(`/v1/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE", ...options }),
    revokeOthers: mutation<void>("/v1/me/sessions/revoke-others", "POST"),
    delete: mutation<void>("/v1/me", "DELETE"),
  },
  phone: {
    requestOtp: (phone: string, options?: ApiRequestOptions) =>
      api<{ phoneMasked: string; expiresAt: string; resendAfterSec: number }>("/v1/phone/otp", {
        method: "POST",
        body: { phone },
        ...options,
      }),
    verify: (phone: string, code: string, options?: ApiRequestOptions) =>
      api<{ me: Me; readyIntents: number }>("/v1/phone/verify", {
        method: "POST",
        body: { phone, code },
        ...options,
      }),
    unlink: mutation<void>("/v1/phone", "DELETE"),
    cancelClaim: mutation<void>("/v1/phone/claim", "DELETE"),
  },
  resolve: (phone: string, options?: ApiRequestOptions) =>
    api<ResolveResponse>("/v1/resolve", { method: "POST", body: { phone }, ...options }),
  tokens: {
    list: (options?: ApiRequestOptions) => api<{ items: Token[] }>("/v1/tokens", options),
  },
  wallet: {
    balances: (params: { refresh?: boolean } = {}, options?: ApiRequestOptions) =>
      api<BalancesResponse>(
        withQuery("/v1/wallet/balances", { refresh: params.refresh ? 1 : undefined }),
        options,
      ),
  },
  contacts: {
    list: (options?: ApiRequestOptions) => api<{ items: Contact[] }>("/v1/contacts", options),
    create: (input: ContactCreateInput, options?: ApiRequestOptions) =>
      api<{ contact: Contact }>("/v1/contacts", { method: "POST", body: input, ...options }),
    update: (id: string, input: ContactUpdateInput, options?: ApiRequestOptions) =>
      api<{ contact: Contact }>(`/v1/contacts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: input,
        ...options,
      }),
    remove: (id: string, options?: ApiRequestOptions) =>
      api<void>(`/v1/contacts/${encodeURIComponent(id)}`, { method: "DELETE", ...options }),
  },
  transfers: {
    create: (input: TransferCreateInput, options?: ApiRequestOptions) =>
      api<{ transfer: Transfer }>("/v1/transfers", { method: "POST", body: input, ...options }),
    list: (params: TransferListParams = {}, options?: ApiRequestOptions) =>
      api<Page<Transfer>>(withQuery("/v1/transfers", params), options),
    get: (id: string, options?: ApiRequestOptions) =>
      api<{ transfer: Transfer }>(`/v1/transfers/${encodeURIComponent(id)}`, options),
    exportCsv: (direction: TransferDirection = "all", options?: ApiRequestOptions) =>
      api<Blob>(withQuery("/v1/transfers/export.csv", { direction }), {
        ...options,
        responseType: "blob",
      }),
    exportUrl: (direction: TransferDirection = "all") =>
      apiUrl(withQuery("/v1/transfers/export.csv", { direction })),
  },
  intents: {
    create: (input: IntentCreateInput, options?: ApiRequestOptions) =>
      api<{ intent: Intent }>("/v1/intents", { method: "POST", body: input, ...options }),
    list: (status: IntentStatusFilter = "open", options?: ApiRequestOptions) =>
      api<{ items: Intent[] }>(withQuery("/v1/intents", { status }), options),
    cancel: (id: string, options?: ApiRequestOptions) =>
      api<{ intent: Intent }>(`/v1/intents/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        ...options,
      }),
    incoming: (options?: ApiRequestOptions) =>
      api<{ items: IncomingIntent[] }>("/v1/intents/incoming", options),
  },
  claims: {
    get: (code: string, options?: ApiRequestOptions) =>
      api<ClaimView>(`/v1/claims/${encodeURIComponent(code)}`, options),
  },
  notifications: {
    list: (limit = 50, options?: ApiRequestOptions) =>
      api<{ items: Notification[]; unreadCount: number }>(
        withQuery("/v1/notifications", { limit }),
        options,
      ),
    read: (input: NotificationReadInput, options?: ApiRequestOptions) =>
      api<void>("/v1/notifications/read", { method: "POST", body: input, ...options }),
  },
  config: {
    get: (options?: ApiRequestOptions) => api<ConfigResponse>("/v1/config", options),
  },
} as const;
