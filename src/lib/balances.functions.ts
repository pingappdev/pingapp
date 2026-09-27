import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { chains, DEFAULT_NETWORK } from "@/chains";

export const fetchBalances = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { address: string; network?: string }) => {
    const network = input.network ?? DEFAULT_NETWORK;
    if (
      typeof input.address !== "string" ||
      !/^0x[a-fA-F0-9]{40}$/.test(input.address) ||
      !Object.hasOwn(chains, network)
    )
      throw new Error("Select a supported network and valid address.");
    return { address: input.address, network };
  })
  .handler(async ({ data }) => {
    const { readNetworkBalances } = await import("@/lib/network-balances.server");
    try {
      return await readNetworkBalances(
        data.address,
        data.network,
        process.env["ROBINHOOD_RPC_URL"],
      );
    } catch {
      throw new Error(
        "This network is not responding. Your funds remain in your wallet. Try refreshing shortly.",
      );
    }
  });
