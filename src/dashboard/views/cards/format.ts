export function usd(value: string | null | undefined): string {
  if (value == null || !/^-?\d+(\.\d+)?$/.test(value)) return "Unavailable";
  const [whole, fraction = ""] = value.split(".");
  return `${whole.startsWith("-") ? "−" : ""}$${whole.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

export function dateTime(value: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "Unavailable";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function statusLabel(value: string): string {
  return value.replace(/_/g, " ");
}

export async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}
