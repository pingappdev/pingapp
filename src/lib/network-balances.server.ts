import { chains } from "@/chains";

export type Balances = { eth: string; usdc: string | null; network: string; updated: number };

function decimal(hex: string, places: number) {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error("Invalid balance response");
  const s = BigInt(hex).toString().padStart(places + 1, "0");
  return s.slice(0, -places) + "." + s.slice(-places);
}

export async function readNetworkBalances(
  address: string,
  network: string,
  robinhoodRpc?: string,
): Promise<Balances> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address) || !Object.hasOwn(chains, network))
    throw new Error("Select a supported network and valid EVM address.");
  const chain = chains[network]!;
  const url = network === "robinhood" && robinhoodRpc ? robinhoodRpc : chain.rpc;
  if (new URL(url).protocol !== "https:") throw new Error("RPC must use HTTPS.");
  const call = async (method: string, params: unknown[]) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error("Network unavailable");
    const d = (await r.json()) as { result?: string; error?: unknown };
    if (typeof d.result !== "string" || d.error) throw new Error("Unable to read network");
    return d.result;
  };
  if ((await call("eth_chainId", [])) !== chain.id)
    throw new Error("RPC network does not match the selected chain.");
  const [eth, usdc] = await Promise.all([
    call("eth_getBalance", [address, "latest"]),
    chain.usdc
      ? call("eth_call", [
          {
            to: chain.usdc,
            data: "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0"),
          },
          "latest",
        ])
      : Promise.resolve(null),
  ]);
  return {
    eth: decimal(eth, 18),
    usdc: usdc === null ? null : decimal(usdc, 6),
    network,
    updated: Date.now(),
  };
}
