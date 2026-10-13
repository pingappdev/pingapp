import { Copy, ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { useAuth } from "../../auth/useAuth";
import { chain, explorerAddress } from "../../config";
import NetworkLabel from "./NetworkLabel";

export default function ReceiveDialog() {
  const { me } = useAuth();
  if (!me) return null;
  const walletAddress = me.address;

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(walletAddress);
      toast.success("Address copied");
    } catch {
      toast.error("Copy was unavailable. You can select and copy the address.");
    }
  }

  return (
    <>
      <div className="receive-network">
        <NetworkLabel _network="robinhood" />
        <span>{chain.testnet ? "Testnet" : "Mainnet"}</span>
      </div>
      <div className="receive-mark">
        <div style={{ backgroundColor: "#fff", borderRadius: 18, lineHeight: 0, padding: 12 }}>
          <QRCodeSVG
            value={`ethereum:${walletAddress}@${chain.id}`}
            size={200}
            marginSize={4}
            level="H"
            bgColor="#fff"
            fgColor="#111"
            imageSettings={{
              src: "/assets/pingapp-logo-1x1.png",
              width: 42,
              height: 42,
              excavate: true,
            }}
          />
        </div>
      </div>
      <p className="receive-address">{walletAddress}</p>
      <button type="button" className="button accent" onClick={() => void copyAddress()}>
        Copy address <Copy size={17} />
      </button>
      {me.phone ? (
        <p className="field-help">Friends on PingApp can send to your number: {me.phone.masked}</p>
      ) : (
        <a className="text-link" href="/dashboard/settings">
          Link your phone number
        </a>
      )}
      <p className="field-help">
        Only receive assets on Robinhood Chain. Sending from another network can lose funds.
      </p>
      <a
        className="text-link"
        href={explorerAddress(walletAddress)}
        target="_blank"
        rel="noreferrer"
      >
        View in explorer <ExternalLink size={15} />
      </a>
    </>
  );
}
