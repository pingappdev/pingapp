export type Address = `0x${string}`;

export type Me = {
  id: string;
  address: Address;
  displayName: string;
  createdAt: string;
  phone: null | {
    e164: string;
    masked: string;
    country: string;
    linkedAt: string;
  };
  pendingClaim: null | {
    id: string;
    phoneMasked: string;
    status: "pending_review";
    createdAt: string;
  };
  freshUntil: string | null;
};

export type Token = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: "native" | "stable" | "wrapped" | "stock";
  logoUrl: string | null;
  priceUsd: string | null;
  minAmount: string | null;
};

export type Asset = {
  token: Token;
  balanceRaw: string;
  balance: string;
  valueUsd: string | null;
};

export type Party = {
  address: Address;
  displayName: string | null;
  phoneMasked: string | null;
  isMe: boolean;
};

export type Transfer = {
  id: string;
  direction: "sent" | "received";
  txHash: `0x${string}`;
  status: "submitted" | "confirmed" | "failed" | "unverified" | "not_found";
  token: Token;
  amountRaw: string;
  amount: string;
  from: Party;
  to: Party;
  contactName: string | null;
  intentId: string | null;
  explorerUrl: string;
  createdAt: string;
  confirmedAt: string | null;
};

export type Intent = {
  id: string;
  code: string;
  status: "pending" | "ready" | "completed" | "cancelled" | "expired";
  smsStatus: "sent" | "skipped_rate_limit" | "failed" | "disabled";
  recipientPhoneMasked: string;
  recipient: null | { address: Address; displayName: string };
  token: Token;
  amountRaw: string;
  amount: string;
  note: string | null;
  transferId: string | null;
  claimUrl: string;
  expiresAt: string;
  createdAt: string;
  readyAt: string | null;
  completedAt: string | null;
};

export type IncomingIntent = {
  id: string;
  status: "ready" | "completed";
  sender: { address: Address; displayName: string };
  token: Token;
  amount: string;
  note: string | null;
  createdAt: string;
};

export type Contact = {
  id: string;
  name: string;
  phone: string | null;
  phoneMasked: string | null;
  address: Address | null;
  onPingApp: null | { address: Address; displayName: string; linkedAt: string };
  createdAt: string;
};

export type Notification = {
  id: string;
  type:
    | "intent_ready"
    | "intent_expired"
    | "intent_incoming"
    | "transfer_received"
    | "transfer_failed"
    | "phone_claim_attempt"
    | "phone_claim_resolved"
    | "phone_removed_by_review";
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export type ResolveResponse =
  | {
      status: "registered";
      phoneMasked: string;
      recipient: {
        address: Address;
        displayName: string;
        linkedAt: string;
        recentlyLinked: boolean;
        underReview: boolean;
        previouslySentByMe: boolean;
      };
    }
  | { status: "not_registered"; phoneMasked: string; canCreateIntent: boolean };

export type ClaimView = {
  status: Intent["status"];
  senderDisplayName: string;
  token: Pick<Token, "symbol" | "name" | "logoUrl" | "decimals">;
  amount: string;
  note: string | null;
  recipientPhoneMasked: string;
  expiresAt: string;
};

export type SessionInfo = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  current: boolean;
};

export type BalancesResponse = {
  address: Address;
  updatedAt: string;
  totalUsd: string | null;
  items: Asset[];
};

export type ConfigResponse = {
  chain: {
    id: number;
    name: string;
    explorerUrl: string;
    publicRpcUrl: string;
    nativeSymbol: string;
    isTestnet: boolean;
  };
  features: { intents: boolean; sms: boolean };
  limits: { intentTtlDays: number; recentlyLinkedDays: number; minSendUsd: string };
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type ApiRequestOptions = { signal?: AbortSignal };
export type TransferDirection = "all" | "sent" | "received";
export type IntentStatusFilter = "open" | "all";

export type ContactCreateInput = {
  name: string;
  phone?: string | null;
  address?: string | null;
};
export type ContactUpdateInput = Partial<ContactCreateInput>;

export type TransferCreateInput = {
  txHash: `0x${string}`;
  tokenAddress: Address;
  amountRaw: string;
  toAddress: Address;
  recipientPhone?: string;
  contactId?: string;
  intentId?: string;
};

export type TransferListParams = {
  direction?: TransferDirection;
  cursor?: string;
  limit?: number;
};

export type IntentCreateInput = {
  phone: string;
  tokenAddress: Address;
  amount: string;
  note?: string;
};

export type NotificationReadInput = { ids?: string[]; all?: boolean };
