import { platform } from "@/platform";
import { Copy } from "lucide-react";
import { toast } from "sonner";

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export default function AddressText({ value, full = false }: { value: string; full?: boolean }) {
  const displayValue = full ? (value.match(/.{1,4}/g)?.join(" ") ?? value) : shortAddress(value);

  async function copyAddress() {
    try {
      await platform.copyText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy was unavailable. You can select and copy the address.");
    }
  }

  return (
    <span className={`address-text${full ? " full" : ""}`}>
      <code title={value}>{displayValue}</code>
      <button
        type="button"
        aria-label="Copy address"
        title="Copy address"
        onClick={() => void copyAddress()}
      >
        <Copy size={13} />
      </button>
    </span>
  );
}
