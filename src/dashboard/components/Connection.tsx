import { useDashboard } from "../state";
import { useAccount } from "wagmi";
import { useAuth } from "../../auth/useAuth";
import { openConnect } from "../../wallet/appkit";

export default function Connection() {
  const { wallet } = useDashboard();
  const { me } = useAuth();
  const account = useAccount();
  const sessionAddress = me?.address ?? wallet;
  const connected =
    account.isConnected &&
    !!sessionAddress &&
    account.address?.toLowerCase() === sessionAddress.toLowerCase();
  return (
    <div className="connection-status">
      <span className={connected ? "status-dot" : "status-dot off"} />
      {connected ? (
        "Wallet connected"
      ) : (
        <>
          <span>Wallet not connected</span>
          <button type="button" className="connection-action" onClick={() => void openConnect()}>
            Connect
          </button>
        </>
      )}
    </div>
  );
}
