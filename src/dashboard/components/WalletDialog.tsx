import { ArrowUpRight, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useDashboard } from "../state";
import { isAddress } from "../format";

export default function WalletDialog() {
  const { busy, connect, saveProfile, setBusy, setModal, readAddress, setReadAddress } =
    useDashboard();

  return (
    <>
      <button
        className="wallet-choice"
        disabled={busy}
        onClick={() => {
          if (
            typeof window !== "undefined" &&
            (window as unknown as { ethereum?: unknown }).ethereum !== undefined
          )
            connect();
          else
            toast.error(
              "No browser wallet detected. Open PingApp in your wallet’s browser, or install your preferred wallet extension.",
            );
        }}
      >
        <Wallet />
        <span>
          Browser wallet<small>MetaMask, Rainbow, Coinbase Wallet</small>
        </span>
        <ArrowUpRight size={17} />
      </button>
      <p className="divider-label">OR VIEW AN ADDRESS</p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!isAddress(readAddress)) {
            toast.error("Enter a valid EVM address.");
            return;
          }
          setBusy(true);
          try {
            await saveProfile({ wallet: readAddress });
            setModal("");
            toast.success("Read-only wallet added");
          } catch (error) {
            toast.error((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Public wallet address
          <input
            required
            value={readAddress}
            onChange={(event) => setReadAddress(event.target.value.trim())}
            placeholder="0x…"
          />
        </label>
        <button className="button outline" disabled={busy}>
          View balances <ArrowUpRight size={16} />
        </button>
      </form>
      <p className="field-help">
        Read-only addresses cannot approve transfers. No seed phrase is ever needed.
      </p>
    </>
  );
}
