import { LoaderCircle } from "lucide-react";
import type { Intent, Transfer } from "../../api/types";

type Status = Transfer["status"] | Intent["status"];

const labels: Record<Status, string> = {
  submitted: "Pending",
  confirmed: "Confirmed",
  failed: "Failed",
  unverified: "Check explorer",
  not_found: "Not found",
  pending: "Waiting for signup",
  ready: "Ready to send",
  completed: "Completed",
  cancelled: "Canceled",
  expired: "Expired",
};

export default function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`pill status-pill status-${status}`}>
      {status === "submitted" && <LoaderCircle size={12} className="status-spinner spin" />}
      {labels[status]}
    </span>
  );
}
