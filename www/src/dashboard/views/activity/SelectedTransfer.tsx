import { useTransfer } from "../../../api/hooks";
import ActivityTable from "../../components/ActivityTable";

export default function SelectedTransfer({ id }: { id: string }) {
  const transfer = useTransfer(id);
  return (
    <section className="card">
      <div className="panel-heading">
        <h2>Transfer details</h2>
        <a className="text-link" href="/dashboard/activity">
          View all activity
        </a>
      </div>
      {transfer.isPending ? (
        <p className="field-help" role="status">
          Loading transfer…
        </p>
      ) : transfer.isError ? (
        <div className="notice" role="alert">
          <p>This transfer could not be loaded. It may no longer be available to this account.</p>
          <button
            className="button outline"
            type="button"
            disabled={transfer.isFetching}
            onClick={() => void transfer.refetch()}
          >
            Try again
          </button>
        </div>
      ) : transfer.data ? (
        <ActivityTable rows={[transfer.data]} />
      ) : null}
    </section>
  );
}
