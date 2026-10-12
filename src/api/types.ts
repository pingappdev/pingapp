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
  recipient: null | { displayName: string };
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
  phone: string;
  phoneMasked: string;
  onPingApp: null | { displayName: string };
  createdAt: string;
};

export type Notification = {
  id: string;
  type:
    | "intent_ready"
    | "escrow_ready"
    | "escrow_incoming"
    | "escrow_claimed"
    | "escrow_received"
    | "escrow_refunded"
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
        recipientRef: string;
        displayName: string;
        underReview: boolean;
        previouslySentByMe: boolean;
      };
    }
  | { status: "not_registered"; phoneMasked: string; canCreateIntent: boolean };

export type ClaimView = {
  kind?: "escrow";
  id?: string;
  status: Intent["status"] | Escrow["status"];
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
  features: { intents: boolean; sms: boolean; escrow: boolean };
  router: { enabled: boolean; address: Address | ""; escrowFeeWei: string; claimTipWei: string };
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

export type ContactCreateInput = { name: string; phone: string };
export type ContactUpdateInput = { name?: string; phone?: string };

export type TransferCreateInput = {
  txHash: `0x${string}`;
  expectedSenderAddress: Address;
  tokenAddress: Address;
  amountRaw: string;
  toAddress: Address;
  recipientPhone?: string;
  contactId?: string;
  intentId?: string;
  routerId?: string;
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

export type AuthorizeSendInput = {
  phone: string;
  tokenAddress: Address;
  amount: string;
  expectedSenderAddress: Address;
  expectedRecipientRef: string | null;
  contactId?: string;
  note?: string;
};
type RouterAuthBase = {
  id: Address;
  sender: Address;
  token: Address;
  amount: string;
  deadline: string;
};
type RouterAuthorizationBase = {
  router: Address;
  signature: Address;
  value: string;
  approval: null | { token: Address; spender: Address; amount: string };
};
export type RouterAuthorization = RouterAuthorizationBase & {
  mode: "escrow";
  deliveryMode: "automatic" | "claim";
  escrowId: string;
  auth: RouterAuthBase & { claimTip: string; expiresAt: string };
  feeWei: string;
  claimTipWei: string;
  expiresAt: string;
};
export type Escrow = {
  id: Address;
  code: string;
  status: "authorized" | "deposited" | "claiming" | "claimed" | "refunded" | "void";
  smsStatus: Intent["smsStatus"] | "not_required";
  deliveryMode: "automatic" | "claim";
  recipientPhoneMasked: string | null;
  sender: { address: Address; displayName: string };
  token: Token;
  amountRaw: string;
  amount: string;
  claimTipWei: string;
  feeWei: string;
  note: string | null;
  claimUrl: string;
  expiresAt: string;
  createdAt: string;
  depositedAt: string | null;
  claimedAt: string | null;
  refundedAt: string | null;
  depositTxHash: Address | null;
  claimTxHash: Address | null;
  refundTxHash: Address | null;
  refundable: boolean;
};
