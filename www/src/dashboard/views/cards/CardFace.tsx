import { Snowflake } from "lucide-react";
import { statusLabel } from "./format";

/** A card illustration tinted per product, used by the card rail and the product picker. */
export function CardFace({
  product,
  name,
  network,
  last4,
  status,
  statusText,
  frozen,
  size = "rail",
}: {
  product: string;
  name: string;
  network: string;
  last4?: string | null;
  status?: string;
  /** Friendly chip text for the card list; defaults to the provider status. */
  statusText?: string | null;
  frozen?: boolean | null;
  size?: "rail" | "mini";
}) {
  const pending = status !== undefined && status !== "issued";
  return (
    <span
      className={`pc-face pc-face-${size}`}
      data-product={product}
      data-frozen={frozen === true || undefined}
      data-pending={pending || undefined}
      aria-hidden="true"
    >
      <span className="pc-face-top">
        <span className="pc-face-brand">
          <span className="pc-face-mark" />
          Ping
        </span>
        <span className="pc-face-network">{network}</span>
      </span>
      {size === "rail" && (
        <span className="pc-face-number">
          <span>••••</span>
          <span>{last4 ?? "····"}</span>
        </span>
      )}
      <span className="pc-face-bottom">
        <span className="pc-face-name">{size === "rail" ? name : null}</span>
        {frozen === true ? (
          <span className="pc-face-chip">
            <Snowflake size={11} /> Frozen
          </span>
        ) : statusText ? (
          <span className="pc-face-chip">{statusText}</span>
        ) : pending ? (
          <span className="pc-face-chip">{statusLabel(status!)}</span>
        ) : null}
      </span>
    </span>
  );
}
