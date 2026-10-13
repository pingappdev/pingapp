import { formatUnits, parseEther } from "viem";
import type { Asset } from "../../../api/types";
import Usd from "../../components/Usd";
import { rawAmount, usdForRaw } from "./money";

const GAS_RESERVE = parseEther("0.0002");

export default function AmountField({
  asset,
  value,
  onChange,
  error,
  locked,
}: {
  asset: Asset | null;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  locked?: boolean;
}) {
  const parsed = asset ? rawAmount(value, asset.token.decimals) : null;
  const usd = asset && parsed !== null ? usdForRaw(parsed, asset.token) : null;
  const max = () => {
    if (!asset) return;
    const balance = BigInt(asset.balanceRaw);
    const raw =
      asset.token.kind === "native"
        ? balance > GAS_RESERVE
          ? balance - GAS_RESERVE
          : 0n
        : balance;
    onChange(formatUnits(raw, asset.token.decimals));
  };
  return (
    <div className="send-amount-field">
      <label htmlFor="send-amount">Amount</label>
      <div className="amount-input">
        <input
          id="send-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          disabled={locked || !asset}
          onChange={(event) => onChange(event.target.value.replace(/,/g, "."))}
          aria-invalid={!!error}
        />
        <span>{asset?.token.symbol}</span>
      </div>
      <p className="field-help">
        {asset?.balance ?? "0"} {asset?.token.symbol ?? ""} available · <Usd value={usd} />{" "}
        estimated
      </p>
      {!locked && (
        <button type="button" className="send-max" onClick={max} disabled={!asset}>
          Max
        </button>
      )}
      {error && (
        <p className="field-help send-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
