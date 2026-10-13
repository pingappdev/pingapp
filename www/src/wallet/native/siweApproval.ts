import { stringToHex, type Address, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { chain } from "@/config";
import { config } from "@/env";
import type { ApprovalRequest } from "./provider";

export const LOGIN_STATEMENT =
  "Sign in to PingApp. This only proves you own this wallet. It costs no gas and moves no funds.";
export const REAUTH_STATEMENT = "Confirm a sensitive PingApp action.";

// Only messages built here can arm a permit. No provider parameter, DOM event,
// window property or persisted flag can authorize a signature.
const permits = new Set<{ address: Address; message: Hex }>();
export function consumeTrustedSiwe(request: ApprovalRequest): boolean {
  if (request.kind !== "message") return false;
  for (const permit of permits) {
    if (permit.address.toLowerCase() === request.summary.address.toLowerCase() &&
        permit.message === request.summary.message) {
      permits.delete(permit);
      return true;
    }
  }
  return false;
}

export async function signAppSiwe(
  kind: "login" | "reauth",
  nonce: string,
  address: Address,
  sign: (message: string) => Promise<Hex>,
): Promise<{ message: string; signature: Hex }> {
  const appUrl = new URL(config.appUrl);
  const message = createSiweMessage({
    domain: appUrl.host,
    uri: appUrl.href,
    address,
    version: "1",
    chainId: chain.id,
    nonce,
    issuedAt: new Date(),
    statement: kind === "login" ? LOGIN_STATEMENT : REAUTH_STATEMENT,
  });
  const permit = { address, message: stringToHex(message) };
  permits.add(permit);
  try {
    return { message, signature: await sign(message) };
  } finally {
    permits.delete(permit);
  }
}
