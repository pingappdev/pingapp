import { useDashboard } from "../state";
import { useAccount } from "wagmi";

export default function Connection() {
  const { wallet } = useDashboard();
  const account = useAccount();
  const connected = !!wallet && account.address?.toLowerCase() === wallet.toLowerCase();
  return (
    <div className="connection-status">
      <span className={connected ? "status-dot" : "status-dot off"} />
      {connected ? "Wallet connected" : wallet ? "Wallet reconnecting" : "Wallet not connected"}
    </div>
  );
}
