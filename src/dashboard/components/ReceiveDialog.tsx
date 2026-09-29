import { Copy, ExternalLink } from "lucide-react";
import { explorerAddress } from "../../config";
import { useDashboard } from "../state";
import NetworkLabel from "./NetworkLabel";

export default function ReceiveDialog() {
  const { network, wallet, copy } = useDashboard();

  return (
    <>
      <div className="receive-network">
        <NetworkLabel _network={network} />
      </div>
      <div className="receive-mark">
        <img src="/assets/pingapp-logo-1x1.png" alt="PingApp" />
      </div>
      <p className="receive-address">{wallet}</p>
      <button className="button accent" onClick={() => copy(wallet)}>
        Copy address <Copy size={17} />
      </button>
      <a className="text-link" href={explorerAddress(wallet)} target="_blank" rel="noreferrer">
        View wallet in explorer <ExternalLink size={15} />
      </a>
    </>
  );
}
