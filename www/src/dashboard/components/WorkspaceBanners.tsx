import { useState } from "react";
import { toast } from "sonner";
import { useAccount, useSwitchChain } from "wagmi";
import { useCancelClaim } from "../../api/hooks";
import { useAuth } from "../../auth/useAuth";
import { chain } from "../../config";

export default function WorkspaceBanners() {
  const { me } = useAuth();
  const account = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const cancelClaim = useCancelClaim();
  const [switching, setSwitching] = useState(false);
  const wrongChain = account.isConnected && account.chainId !== chain.id;

  async function switchNetwork() {
    setSwitching(true);
    try {
      await switchChainAsync({ chainId: chain.id });
    } catch (error) {
      toast.error((error as Error).message || "Could not switch networks.");
    } finally {
      setSwitching(false);
    }
  }

  async function cancelPendingClaim() {
    try {
      await cancelClaim.mutateAsync();
      toast.success("Your review request was canceled.");
    } catch (error) {
      toast.error((error as Error).message || "Could not cancel the request.");
    }
  }

  if (!me?.pendingClaim && !wrongChain) return null;

  return (
    <div className="workspace-banners" aria-live="polite">
      {me?.pendingClaim && (
        <section className="workspace-banner claim-banner" role="status">
          <div>
            <strong>Your number is under review</strong>
            <p>Your request to link {me.pendingClaim.phoneMasked} is under manual review.</p>
          </div>
          <div className="workspace-banner-actions">
            <a href="/contact">Contact support</a>
            <button
              type="button"
              onClick={() => void cancelPendingClaim()}
              disabled={cancelClaim.isPending}
            >
              {cancelClaim.isPending ? "Canceling…" : "Cancel request"}
            </button>
          </div>
        </section>
      )}
      {wrongChain && (
        <section className="workspace-banner network-banner" role="status">
          <div>
            <strong>Switch to Robinhood Chain</strong>
            <p>Your wallet is connected to another network.</p>
          </div>
          <button type="button" onClick={() => void switchNetwork()} disabled={switching}>
            {switching ? "Switching…" : "Switch to Robinhood Chain"}
          </button>
        </section>
      )}
    </div>
  );
}
