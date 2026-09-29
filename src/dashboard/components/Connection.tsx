import { useDashboard } from "../state";

export default function Connection() {
  const { wallet, connected } = useDashboard();
  return (
    <div className="connection-status">
      <span className={wallet ? "status-dot" : "status-dot off"} />
      {wallet
        ? connected.toLowerCase() === wallet.toLowerCase()
          ? "Wallet connected"
          : "Read-only wallet"
        : "Wallet not connected"}
    </div>
  );
}
