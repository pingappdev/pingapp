function groupDigits(value: string, group: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, group);
}

function formatUsd(value: string | null): string {
  if (value === null) return "—";
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return "—";

  const [, sign, integer, rawFraction = ""] = match;
  const parts = new Intl.NumberFormat().formatToParts(1000.1);
  const group = parts.find((part) => part.type === "group")?.value ?? ",";
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
  const cents = BigInt(rawFraction.slice(0, 2).padEnd(2, "0"));
  const roundUp = rawFraction.length > 2 && rawFraction[2] >= "5";
  const totalCents = BigInt(integer) * 100n + cents + (roundUp ? 1n : 0n);
  const whole = groupDigits((totalCents / 100n).toString(), group);
  const fraction = (totalCents % 100n).toString().padStart(2, "0");
  const minus = sign && totalCents > 0n ? "−" : "";
  return `${minus}$${whole}${decimal}${fraction}`;
}

export default function Usd({ value }: { value: string | null }) {
  return <span className="usd-value">{formatUsd(value)}</span>;
}
