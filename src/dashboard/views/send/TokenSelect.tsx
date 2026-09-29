import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Asset } from "../../../api/types";
import TokenIcon from "../../components/TokenIcon";
import { rawAmount } from "./money";

function reason(asset: Asset, minSendUsd: string): string | null {
  if (asset.token.minAmount === null) return "Price unavailable, so it can't be sent right now";
  const minimum = rawAmount(asset.token.minAmount, asset.token.decimals);
  if (minimum !== null && BigInt(asset.balanceRaw) < minimum)
    return `Below the $${minSendUsd} minimum`;
  return null;
}

export default function TokenSelect({
  assets,
  selected,
  onSelect,
  minSendUsd,
  locked,
}: {
  assets: Asset[];
  selected: Asset | null;
  onSelect: (asset: Asset) => void;
  minSendUsd: string;
  locked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const available = assets.filter(
    (asset) => asset.token.kind === "native" || BigInt(asset.balanceRaw) > 0n,
  );
  return (
    <div className="send-token-select">
      <label>Token</label>
      <button
        type="button"
        className="send-token-trigger"
        onClick={() => setOpen(!open)}
        disabled={locked}
        aria-expanded={open}
      >
        {selected ? (
          <>
            <TokenIcon {...selected.token} />
            <span>
              <strong>{selected.token.symbol}</strong>
              <small>{selected.token.name.replace(" • Robinhood Token", "")}</small>
            </span>
          </>
        ) : (
          "Choose a token"
        )}
        <ChevronDown size={16} />
      </button>
      {open && !locked && (
        <div className="send-token-options" role="listbox" aria-label="Token">
          {available.map((asset) => {
            const disabledReason = reason(asset, minSendUsd);
            return (
              <button
                type="button"
                role="option"
                aria-selected={
                  selected?.token.address.toLowerCase() === asset.token.address.toLowerCase()
                }
                key={asset.token.address}
                disabled={!!disabledReason}
                onClick={() => {
                  onSelect(asset);
                  setOpen(false);
                }}
              >
                <TokenIcon {...asset.token} />
                <span>
                  <strong>{asset.token.symbol}</strong>
                  <small>{asset.token.name.replace(" • Robinhood Token", "")}</small>
                </span>
                <span className="send-token-balance">
                  {asset.balance} {asset.token.symbol}
                  {disabledReason && <small>{disabledReason}</small>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
