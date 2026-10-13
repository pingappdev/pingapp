import { useEffect, useState } from "react";
import type { Token } from "../../api/types";

type TokenIconProps = Pick<Token, "symbol" | "logoUrl">;

export default function TokenIcon({ symbol, logoUrl }: TokenIconProps) {
  const imageUrl = symbol.toUpperCase() === "ETH" ? "/assets/brands/ethereum.svg" : logoUrl;
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [imageUrl]);

  const hue = [...symbol].reduce((value, character) => value + character.charCodeAt(0), 0) % 360;

  return (
    <span
      className={`token-icon token-icon-fallback${symbol.toUpperCase() === "ETH" ? " eth" : ""}`}
      style={{ backgroundColor: `hsl(${hue} 35% 28%)` }}
      aria-hidden="true"
    >
      {imageUrl && !imageFailed ? (
        <img src={imageUrl} alt="" width={36} height={36} onError={() => setImageFailed(true)} />
      ) : (
        <span>{symbol.trim().charAt(0).toUpperCase() || "?"}</span>
      )}
    </span>
  );
}
