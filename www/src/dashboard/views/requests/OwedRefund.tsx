import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatEther, isAddress } from "viem";
import { getAccount, getPublicClient } from "wagmi/actions";
import { useSwitchChain, useWriteContract } from "wagmi";
import { toast } from "sonner";
import type { Address } from "../../../api/types";
import { chain } from "../../../config";
import { wagmiAdapter } from "../../../wallet/appkit";
import { pingRouterAbi } from "../../../wallet/pingRouterAbi";
import { errorMessage } from "../send/errors";
import { owedRefundKey } from "./utils";

/**
 * Refund ETH that the sender's wallet rejected is held by the router. Only this
 * wallet can withdraw it, to any other address it chooses.
 */
export default function OwedRefund({ router, account }: { router: Address; account: Address }) {
  const queryClient = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const owed = useQuery({
    queryKey: owedRefundKey(router, account),
    queryFn: async () => {
      const client = getPublicClient(wagmiAdapter.wagmiConfig, { chainId: chain.id });
      if (!client) throw new Error("The network connection is unavailable.");
      return client.readContract({
        address: router,
        abi: pingRouterAbi,
        functionName: "owedEth",
        args: [account],
      });
    },
    refetchInterval: 30_000,
    retry: false,
  });
  if (!owed.data) return null;

  const destination = to.trim();
  const invalid =
    !isAddress(destination) ||
    destination.toLowerCase() === router.toLowerCase() ||
    /^0x0{40}$/i.test(destination);

  async function withdraw() {
    if (invalid || busy) return;
    setBusy(true);
    try {
      if (getAccount(wagmiAdapter.wagmiConfig).chainId !== chain.id)
        await switchChainAsync({ chainId: chain.id });
      const client = getPublicClient(wagmiAdapter.wagmiConfig, { chainId: chain.id });
      if (!client) throw new Error("The network connection is unavailable.");
      const hash = await writeContractAsync({
        account,
        chainId: chain.id,
        address: router,
        abi: pingRouterAbi,
        functionName: "withdrawOwed",
        args: [destination as Address],
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The withdrawal transaction failed.");
      toast.success("Held refund ETH sent.");
      setTo("");
      void queryClient.invalidateQueries({ queryKey: owedRefundKey(router, account) });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card request-list-card">
      <div className="panel-heading">
        <div>
          <h2>Held refund ETH</h2>
          <p className="field-help">
            {formatEther(owed.data)} ETH from expired escrows could not be delivered because this
            wallet rejects ETH. Send it to another address you control.
          </p>
        </div>
      </div>
      <div className="request-form">
        <input
          className="auth-input"
          placeholder="0x… destination address"
          aria-label="Destination address"
          value={to}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setTo(event.target.value)}
        />
        <div className="request-submit-row">
          <button
            className="button accent"
            disabled={invalid || busy}
            onClick={() => void withdraw()}
          >
            {busy ? "Withdrawing…" : "Withdraw"}
          </button>
          {destination && invalid && <p className="field-help">Enter a valid wallet address.</p>}
        </div>
      </div>
    </section>
  );
}
