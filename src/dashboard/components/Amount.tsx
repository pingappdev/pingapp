function localeSeparators() {
  const parts = new Intl.NumberFormat().formatToParts(1000.1);
  return {
    group: parts.find((part) => part.type === "group")?.value ?? ",",
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
  };
}

function formatStringAmount(value: string, maxDecimals = 6): string {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return value;

  const [, sign, integer, rawFraction = ""] = match;
  const { group, decimal } = localeSeparators();
  const groupedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const fraction = rawFraction.slice(0, Math.max(0, maxDecimals)).replace(/0+$/, "");
  return `${sign}${groupedInteger}${fraction ? `${decimal}${fraction}` : ""}`;
}

export default function Amount({
  value,
  symbol,
  maxDecimals = 6,
}: {
  value: string;
  symbol: string;
  maxDecimals?: number;
}) {
  return (
    <span className="amount">
      <span className="amount-value">{formatStringAmount(value, maxDecimals)}</span>
      <span className="amount-symbol">{symbol}</span>
    </span>
  );
}
