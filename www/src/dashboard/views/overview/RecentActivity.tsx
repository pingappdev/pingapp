import { ArrowUpRight, History } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useTransfers } from "../../../api/hooks";
import ActivityTable from "../../components/ActivityTable";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Recent activity is unavailable.";
}

export default function RecentActivity() {
  const transfers = useTransfers("all");
  const firstPage = transfers.data?.pages[0];
  const recent = firstPage?.items.slice(0, 4) ?? [];

  return (
    <section className="card recent-activity">
      <div className="panel-heading">
        <h2>Recent activity</h2>
        <a href="/dashboard/activity" className="text-link">
          View all <ArrowUpRight size={15} />
        </a>
      </div>
      {transfers.isPending && !transfers.data ? (
        <div className="space-y-3" aria-label="Loading recent activity" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <Skeleton className="h-10 w-full" key={row} />
          ))}
        </div>
      ) : transfers.error && !transfers.data ? (
        <div role="alert">
          <p>{errorText(transfers.error)}</p>
          <button type="button" className="text-link" onClick={() => void transfers.refetch()}>
            Refresh
          </button>
        </div>
      ) : recent.length > 0 ? (
        <>
          {transfers.error && (
            <p className="field-help" role="alert">
              {errorText(transfers.error)}
            </p>
          )}
          <ActivityTable rows={recent} />
        </>
      ) : (
        <>
          {transfers.error && (
            <p className="field-help" role="alert">
              {errorText(transfers.error)}
            </p>
          )}
          <div className="empty-row">
            <span className="round-icon">
              <History size={22} />
            </span>
            <div>
              <strong>No transfers yet</strong>
              <p>Transfers submitted through PingApp will appear here.</p>
            </div>
            <a href="/dashboard/send">
              Start a transfer <ArrowUpRight size={17} />
            </a>
          </div>
        </>
      )}
    </section>
  );
}
