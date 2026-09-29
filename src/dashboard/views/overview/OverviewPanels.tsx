import { ShieldCheck } from "lucide-react";
import OverviewAssets from "./OverviewAssets";
import PendingSendPanels from "./PendingSendPanels";
import RecentActivity from "./RecentActivity";
import SavedRecipients from "./SavedRecipients";

export default function OverviewPanels() {
  return (
    <>
      <div className="dashboard-two-column">
        <OverviewAssets />
        <SavedRecipients />
      </div>
      <PendingSendPanels />
      <RecentActivity />
      <div className="dashboard-bottom-line">
        <ShieldCheck size={16} />
        <span>PingApp connects. Your wallet stays in control.</span>
        <a href="/what-we-do/security">Learn more ↗</a>
      </div>
    </>
  );
}
