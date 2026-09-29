import { ArrowUpRight, History, Search } from "lucide-react";
import { useDashboard } from "../state";
import ActivityTable from "../components/ActivityTable";
import Empty from "../components/Empty";

export default function Activity() {
  const { query, setQuery, shownHistory, history } = useDashboard();

  return (
    <>
      <div className="toolbar activity-toolbar">
        <label className="input-icon">
          <Search size={17} />
          <input
            placeholder="Search hash, address, or amount"
            aria-label="Search activity"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <section className="card">
        {shownHistory.length ? (
          <ActivityTable rows={shownHistory} />
        ) : (
          <Empty
            icon={<History />}
            title="No matching transfers"
            text={
              history.length
                ? "No transfers match your search."
                : "Your submitted transfers will appear here, with a direct link to their on-chain status."
            }
            action={
              <a className="button outline" href="/dashboard/send">
                Send crypto <ArrowUpRight size={16} />
              </a>
            }
          />
        )}
      </section>
      <p className="panel-footnote">
        This log covers transfers submitted through PingApp. Open the explorer for complete wallet
        activity and confirmation status.
      </p>
    </>
  );
}
