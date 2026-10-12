import { BaseError, ContractFunctionRevertedError } from "viem";
import { ApiError } from "../../../api/client";

const routerErrors: Record<string, string> = {
  Expired: "This authorization expired. Review the send again.",
  NotSender: "Reconnect the wallet that authorized this send.",
  IdUsed: "This send was already submitted. Check Activity or Requests.",
  BadSignature: "The send authorization could not be verified. Refresh and review again.",
  BadValue: "The ETH amount or escrow fees changed. Review again.",
  BadAmount: "Enter an amount greater than zero.",
  BadRecipient: "This wallet cannot receive this transfer. Review the recipient.",
  BadExpiry: "The escrow expiry is no longer valid. Review the send again.",
  TipTooHigh: "The claim gas tip exceeds the router limit.",
  NotToken: "This token is unavailable on the selected network.",
  NoEscrow: "This escrow is unavailable or has already been claimed or refunded.",
  NotExpired: "This escrow can only be refunded after its expiry.",
  EscrowExpired: "This escrow expired. Its sender can refund it.",
  NotRelayer: "This claim must be submitted by its authorized relayer.",
  EthTransferFailed: "The receiving wallet rejected ETH. No funds moved in this transaction.",
  NothingReceived: "The token did not deliver any funds to escrow. The transaction was reverted.",
  NothingOwed: "This wallet has no held refund ETH to withdraw.",
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      const friendly = routerErrors[reverted.data.errorName];
      if (friendly) return friendly;
    }
  }
  const candidate = error as {
    name?: string;
    code?: number;
    shortMessage?: string;
    message?: string;
  };
  const message = candidate.shortMessage ?? candidate.message ?? "The wallet request failed.";
  if (
    candidate.name === "UserRejectedRequestError" ||
    candidate.code === 4001 ||
    /user rejected|user denied/i.test(message)
  ) {
    return "Cancelled in your wallet.";
  }
  if (/insufficient funds/i.test(message))
    return "Not enough ETH for the amount, escrow charges and network fee.";
  if (/revert|execution reverted/i.test(message)) {
    return "The token contract rejected this transfer. Some Stock Tokens can only be sent to eligible wallets.";
  }
  return message.length > 220 ? `${message.slice(0, 217)}…` : message;
}
