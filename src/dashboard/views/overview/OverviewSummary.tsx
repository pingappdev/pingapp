import { ChevronRight, History, Users, Wallet } from "lucide-react";
import { useDashboard } from "../../state";

export default function OverviewSummary() {
  const { wallet, connected, contacts, history, balanceError, refreshBalance } = useDashboard();

  return (
    <>
      <div className="workspace-summary" aria-label="Workspace summary">
        <a href="/dashboard/settings">
          <span className="summary-icon">
            <Wallet size={18} />
          </span>
          <span>
            <small>Wallet access</small>
            <strong>
              {wallet
                ? connected.toLowerCase() === wallet.toLowerCase()
                  ? "Connected"
                  : "Read only"
                : "Not connected"}
            </strong>
          </span>
          <ChevronRight size={15} />
        </a>
        <a href="/dashboard/contacts">
          <span className="summary-icon">
            <Users size={18} />
          </span>
          <span>
            <small>Saved contacts</small>
            <strong>
              {contacts.length.toLocaleString()}
              <em>recipients</em>
            </strong>
          </span>
          <ChevronRight size={15} />
        </a>
        <a href="/dashboard/activity">
          <span className="summary-icon">
            <History size={18} />
          </span>
          <span>
            <small>Submitted transfers</small>
            <strong>
              {history.length.toLocaleString()}
              <em>in your activity</em>
            </strong>
          </span>
          <ChevronRight size={15} />
        </a>
      </div>
      {balanceError && (
        <div className="notice">
          {balanceError}
          <button onClick={refreshBalance}>Refresh</button>
        </div>
      )}
    </>
  );
}
