import {
  http,
  isAddress,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type TransactionSerializable,
  type TypedDataDefinition,
} from "viem";
import { chain, config } from "@/config";
import { platform } from "@/platform";
import { keyManager, WalletError, WalletLocked } from "./keyManager";

const allowed = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_sendRawTransaction",
  "eth_getLogs",
]);

export type ApprovalRequest =
  | { kind: "message"; summary: { address: Address; message: Hex } }
  | { kind: "typedData"; summary: { address: Address; typedData: TypedDataDefinition } }
  | {
      kind: "transaction";
      summary: {
        from: Address;
        to?: Address;
        value: string;
        data: Hex;
        chainId: number;
        gas: string;
        maxFeePerGas?: string;
        maxPriorityFeePerGas?: string;
        gasPrice?: string;
      };
    };
export type ApprovalHandler = (request: ApprovalRequest) => Promise<void>;
let approvalHandler: ApprovalHandler | undefined;
let approvalVersion = 0;

export function setApprovalHandler(handler: ApprovalHandler | undefined) {
  approvalHandler = handler;
  approvalVersion++;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message.replace(/(?:0x)?[0-9a-f]{64}/gi, "[redacted]"));
    this.name = "ProviderError";
  }
}
export class InsufficientFunds extends ProviderError {
  constructor() {
    super(-32000, "Insufficient funds: not enough ETH for the amount and network fee.");
    this.name = "InsufficientFunds";
  }
}

// Shared by wagmi reads and this signing provider. Read the token per request,
// never cache it in the configuration or persist it in browser storage.
export const relayTransport = http(config.rpcUrl, {
  batch: true,
  fetchOptions: { headers: { "x-pingapp": "1" }, credentials: "omit" },
  async onFetchRequest(request) {
    const token = await platform.secureStorage.get("pingapp.session.v1");
    if (token) request.headers.set("authorization", `Bearer ${token}`);
  },
});
const relay = relayTransport({ chain, retryCount: 0 });
async function rpc<T>(method: string, params: readonly unknown[] = []): Promise<T> {
  return (await relay.request({ method, params } as never)) as T;
}

function invalid(): never {
  throw new ProviderError(-32602, "The wallet request is invalid.");
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) invalid();
  return BigInt(value);
}
function bytes(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) invalid();
  return value as Hex;
}
function signerAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) invalid();
  const address = keyManager.getAccount().address;
  if (value.toLowerCase() !== address.toLowerCase())
    throw new ProviderError(4100, "This request belongs to another wallet.");
  return address;
}
function ensureUnlocked(epoch: number) {
  if (keyManager.getState() !== "unlocked" || keyManager.getEpoch() !== epoch)
    throw new WalletLocked();
}
async function approve(request: ApprovalRequest, epoch: number) {
  ensureUnlocked(epoch);
  const version = approvalVersion;
  if (approvalHandler) await approvalHandler(structuredClone(request));
  // Temporary local Vite development only; no APK build-time bypass variable.
  // MOB-08 supplies the biometric approval handler. Bundled APKs fail closed.
  else if (!import.meta.env.DEV)
    throw new ProviderError(4100, "Wallet approval is not available. Unlock and try again.");
  ensureUnlocked(epoch);
  ensureApproval(version);
  return version;
}
function ensureApproval(version: number) {
  if (version !== approvalVersion)
    throw new ProviderError(4100, "Wallet approval changed. Review and try again.");
}

async function sendTransaction(input: unknown, epoch: number): Promise<Hex> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const tx = structuredClone(input) as Record<string, unknown>;
  const supported = new Set([
    "from",
    "to",
    "value",
    "data",
    "input",
    "chainId",
    "nonce",
    "gas",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "type",
    "accessList",
  ]);
  if (Object.keys(tx).some((key) => !supported.has(key))) invalid();
  const from = signerAddress(tx.from);
  if (tx.chainId !== undefined && quantity(tx.chainId) !== BigInt(chain.id))
    throw new ProviderError(4902, "Choose the configured Robinhood network.");
  const to =
    tx.to === undefined
      ? undefined
      : typeof tx.to === "string" && isAddress(tx.to, { strict: false })
        ? (tx.to as Address)
        : invalid();
  const value = tx.value === undefined ? 0n : quantity(tx.value);
  const data = bytes(tx.data ?? tx.input ?? "0x");
  if (tx.data !== undefined && tx.input !== undefined && tx.data !== tx.input) invalid();
  const chainId = quantity(await rpc("eth_chainId"));
  if (chainId !== BigInt(chain.id))
    throw new ProviderError(4902, "The wallet and API networks do not match.");
  const block = await rpc<{ gasLimit: Hex; baseFeePerGas?: Hex | null }>("eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  const blockGasLimit = quantity(block.gasLimit);
  const nonceRaw =
    tx.nonce === undefined
      ? quantity(await rpc("eth_getTransactionCount", [from, "pending"]))
      : quantity(tx.nonce);
  if (nonceRaw > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  if (quantity(await rpc("eth_getBalance", [from, "pending"])) <= value)
    throw new InsufficientFunds();
  const estimated = quantity(
    await rpc("eth_estimateGas", [{ from, ...(to ? { to } : {}), value: toHex(value), data }]),
  );
  let gas = tx.gas === undefined ? (estimated * 120n + 99n) / 100n : quantity(tx.gas);
  if (gas > blockGasLimit) gas = blockGasLimit;
  if (gas < estimated)
    throw new ProviderError(-32602, "The transaction needs more gas than the allowed limit.");
  const explicitLegacy = tx.gasPrice !== undefined || tx.type === "0x0" || tx.type === "0x1";
  if (tx.type !== undefined && !["0x0", "0x1", "0x2"].includes(String(tx.type))) invalid();
  if (explicitLegacy && (tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined))
    invalid();
  let fees: { gasPrice: bigint } | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  if (block.baseFeePerGas != null && !explicitLegacy) {
    const base = quantity(block.baseFeePerGas);
    let priority: bigint;
    if (tx.maxPriorityFeePerGas !== undefined) priority = quantity(tx.maxPriorityFeePerGas);
    else {
      try {
        priority = quantity(await rpc("eth_maxPriorityFeePerGas"));
      } catch {
        const history = await rpc<{ reward?: Hex[][] }>("eth_feeHistory", ["0x5", "latest", [50]]);
        const rewards = (history.reward ?? [])
          .flat()
          .map(quantity)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        priority = rewards[Math.floor(rewards.length / 2)] ?? 0n;
      }
    }
    const maximum =
      tx.maxFeePerGas === undefined ? base * 2n + priority : quantity(tx.maxFeePerGas);
    if (maximum < base + priority)
      throw new ProviderError(-32602, "The network fee is too low. Review and try again.");
    fees = { maxFeePerGas: maximum, maxPriorityFeePerGas: priority };
  } else {
    if (tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined || tx.type === "0x2")
      invalid();
    fees = {
      gasPrice:
        tx.gasPrice === undefined ? quantity(await rpc("eth_gasPrice")) : quantity(tx.gasPrice),
    };
  }
  if (tx.accessList !== undefined && !Array.isArray(tx.accessList)) invalid();
  const transaction = {
    chainId: chain.id,
    nonce: Number(nonceRaw),
    ...(to ? { to } : {}),
    value,
    data,
    gas,
    ...fees,
    ...(tx.accessList ? { accessList: tx.accessList } : {}),
    type:
      "gasPrice" in fees ? (tx.type === "0x1" || tx.accessList ? "eip2930" : "legacy") : "eip1559",
  } as TransactionSerializable;
  const maxFee = "gasPrice" in fees ? fees.gasPrice : fees.maxFeePerGas;
  async function checkBalance() {
    const balance = quantity(await rpc("eth_getBalance", [from, "pending"]));
    if (balance < value + gas * maxFee) throw new InsufficientFunds();
  }
  await checkBalance();
  const approval = await approve(
    {
      kind: "transaction",
      summary: {
        from,
        to,
        value: value.toString(),
        data,
        chainId: chain.id,
        gas: gas.toString(),
        ...("gasPrice" in fees
          ? { gasPrice: fees.gasPrice.toString() }
          : {
              maxFeePerGas: fees.maxFeePerGas.toString(),
              maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
            }),
      },
    },
    epoch,
  );
  await checkBalance();
  ensureUnlocked(epoch);
  ensureApproval(approval);
  const raw = await keyManager.getAccount().signTransaction(transaction);
  ensureUnlocked(epoch);
  ensureApproval(approval);
  return rpc<Hex>("eth_sendRawTransaction", [raw]);
}

type Listener = (...args: unknown[]) => void;
const listeners = new Map<string, Set<Listener>>();
let transactionQueue: Promise<unknown> = Promise.resolve();
function emit(event: string, ...args: unknown[]) {
  for (const listener of listeners.get(event) ?? []) {
    try {
      listener(...args);
    } catch {
      /* Isolate consumer callbacks. */
    }
  }
}

export const nativeProvider = {
  on(event: string, listener: Listener) {
    const set = listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(event, set);
    return this;
  },
  removeListener(event: string, listener: Listener) {
    listeners.get(event)?.delete(listener);
    return this;
  },
  async request({
    method,
    params = [],
  }: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown> {
    try {
      if (!Array.isArray(params)) invalid();
      if (method === "eth_chainId") return toHex(chain.id);
      if (method === "eth_accounts" || method === "eth_requestAccounts") {
        if (keyManager.getState() === "unlocked") return [keyManager.getAccount().address];
        if (method === "eth_accounts") return [];
        throw new ProviderError(4100, "Unlock your wallet to connect.");
      }
      if (method === "wallet_switchEthereumChain") {
        const requested = params[0] as { chainId?: unknown } | undefined;
        if (!requested || quantity(requested.chainId) !== BigInt(chain.id))
          throw new ProviderError(
            4902,
            "This wallet supports only the configured Robinhood network.",
          );
        return null;
      }
      const epoch = keyManager.getEpoch();
      if (method === "personal_sign") {
        if (params.length !== 2) invalid();
        // MetaMask accepts both [message, address] and legacy [address, message].
        const signer = keyManager.getAccount().address.toLowerCase();
        const reversed =
          typeof params[0] === "string" &&
          isAddress(params[0], { strict: false }) &&
          params[0].toLowerCase() === signer &&
          !(typeof params[1] === "string" && params[1].toLowerCase() === signer);
        const address = signerAddress(params[reversed ? 0 : 1]);
        const message = params[reversed ? 1 : 0];
        if (typeof message !== "string") invalid();
        const raw = message.startsWith("0x") ? bytes(message) : stringToHex(message);
        const approval = await approve(
          { kind: "message", summary: { address, message: raw } },
          epoch,
        );
        const signature = await keyManager.getAccount().signMessage({ message: { raw } });
        ensureUnlocked(epoch);
        ensureApproval(approval);
        return signature;
      }
      if (method === "eth_signTypedData_v4") {
        if (params.length !== 2 || typeof params[1] !== "string") invalid();
        const address = signerAddress(params[0]);
        const data = JSON.parse(params[1]) as TypedDataDefinition;
        if (
          !data ||
          typeof data !== "object" ||
          !data.domain ||
          !data.types ||
          typeof data.primaryType !== "string" ||
          !data.message
        )
          invalid();
        if (data.domain.chainId !== undefined && BigInt(data.domain.chainId) !== BigInt(chain.id))
          throw new ProviderError(4902, "This signature belongs to another network.");
        const approval = await approve(
          { kind: "typedData", summary: { address, typedData: data } },
          epoch,
        );
        const signature = await keyManager.getAccount().signTypedData(data);
        ensureUnlocked(epoch);
        ensureApproval(approval);
        return signature;
      }
      if (method === "eth_sendTransaction") {
        if (params.length !== 1) invalid();
        // Serialize preparation through broadcast, so simultaneous calls cannot
        // reuse a pending nonce. Never retain raw signing accounts in the queue.
        const input = structuredClone(params[0]);
        const result = transactionQueue.then(() => sendTransaction(input, epoch));
        transactionQueue = result.catch(() => {});
        return await result;
      }
      if (allowed.has(method)) return await rpc(method, params);
      throw new ProviderError(4200, "This wallet method is not supported.");
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof WalletLocked) throw new ProviderError(4100, error.message);
      if (error instanceof WalletError) throw new ProviderError(4100, error.message);
      // Do not pass viem errors/causes through: they can include request data.
      throw new ProviderError(
        -32603,
        "The wallet request failed. Check your connection and try again.",
      );
    }
  },
};

let previousState = keyManager.getState();
keyManager.subscribe(() => {
  const next = keyManager.getState();
  if (next === previousState) return;
  previousState = next;
  emit("accountsChanged", next === "unlocked" ? [keyManager.getAccount().address] : []);
  if (next === "unlocked") {
    emit("chainChanged", toHex(chain.id));
    emit("connect", { chainId: toHex(chain.id) });
  } else emit("disconnect", new ProviderError(4900, "The device wallet is locked."));
});
