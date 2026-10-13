import type { TransferDirection } from "../../api/types";

export function activityDirection(value: string | null): TransferDirection {
  return value === "sent" || value === "received" ? value : "all";
}
