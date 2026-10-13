import { useIncomingIntents, useIntents } from "../../../api/hooks";
import type { IncomingIntent, Intent } from "../../../api/types";
import Amount from "../../components/Amount";
import StatusPill from "../../components/StatusPill";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function IncomingIntentRow({ item }: { item: IncomingIntent }) {
  return (
    <div className="contact-mini">
      <span className="contact-initial">{[...item.sender.displayName][0] ?? "?"}</span>
      <span>
        <strong>
          {item.status === "ready"
            ? `${item.sender.displayName} wants to send you`
            : `Completed send from ${item.sender.displayName}`}
        </strong>
        <small>
          <Amount value={item.amount} symbol={item.token.symbol} />
          {item.status === "ready" && " · They've been notified that you're ready."}
        </small>
      </span>
      <StatusPill status={item.status} />
    </div>
  );
}

function ReadyIntentRow({ item }: { item: Intent }) {
  const recipient = item.recipient?.displayName ?? "your recipient";
  return (
    <a className="contact-mini" href={`/dashboard/send?intent=${encodeURIComponent(item.id)}`}>
      <span className="contact-initial">{[...recipient][0]?.toUpperCase() ?? "?"}</span>
      <span>
        <strong>
          <Amount value={item.amount} symbol={item.token.symbol} /> to {recipient}
        </strong>
        <small>{item.recipientPhoneMasked}</small>
      </span>
      <StatusPill status="ready" />
    </a>
  );
}

function IncomingQueryState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <section className="card">
      <div className="panel-heading">
        <h2>Incoming sends</h2>
      </div>
      {loading ? (
        <p className="field-help">Checking for incoming sends…</p>
      ) : (
        <div role="alert">
          <p>{errorText(error, "Incoming sends are unavailable.")}</p>
          <button type="button" className="text-link" onClick={onRetry}>
            Refresh
          </button>
        </div>
      )}
    </section>
  );
}

function OutgoingQueryState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <section className="card">
      <div className="panel-heading">
        <h2>Ready to send</h2>
      </div>
      {loading ? (
        <p className="field-help">Checking for ready sends…</p>
      ) : (
        <div role="alert">
          <p>{errorText(error, "Ready sends are unavailable.")}</p>
          <button type="button" className="text-link" onClick={onRetry}>
            Refresh
          </button>
        </div>
      )}
    </section>
  );
}

export default function PendingSendPanels() {
  const incoming = useIncomingIntents();
  const outgoing = useIntents("open");
  const incomingReady = incoming.data?.filter((item) => item.status === "ready") ?? [];
  const incomingCompleted = incoming.data?.filter((item) => item.status === "completed") ?? [];
  const outgoingReady = outgoing.data?.filter((item) => item.status === "ready") ?? [];
  const incomingUnavailable = incoming.error instanceof Error ? incoming.error : null;
  const outgoingUnavailable = outgoing.error instanceof Error ? outgoing.error : null;
  const incomingLoading = incoming.isPending && !incoming.data;
  const outgoingLoading = outgoing.isPending && !outgoing.data;
  const showIncomingState =
    incomingLoading ||
    (Boolean(incoming.error) && incomingReady.length === 0 && incomingCompleted.length === 0);
  const showOutgoingState =
    outgoingLoading || (Boolean(outgoing.error) && outgoingReady.length === 0);
  const hasPanels =
    showIncomingState ||
    showOutgoingState ||
    incomingReady.length > 0 ||
    incomingCompleted.length > 0 ||
    outgoingReady.length > 0;

  if (!hasPanels) return null;

  return (
    <div className="dashboard-two-column">
      {showIncomingState && (
        <IncomingQueryState
          loading={incomingLoading}
          error={incomingUnavailable}
          onRetry={() => void incoming.refetch()}
        />
      )}
      {incomingReady.length > 0 && (
        <section className="card">
          <div className="panel-heading">
            <h2>People waiting to send you</h2>
          </div>
          {incoming.error && (
            <p className="field-help" role="alert">
              {errorText(incoming.error, "Incoming sends could not be refreshed.")}
            </p>
          )}
          {incomingReady.map((item) => (
            <IncomingIntentRow key={item.id} item={item} />
          ))}
        </section>
      )}
      {incomingCompleted.length > 0 && (
        <section className="card">
          <div className="panel-heading">
            <h2>Recently completed incoming sends</h2>
          </div>
          {incoming.error && (
            <p className="field-help" role="alert">
              {errorText(incoming.error, "Incoming sends could not be refreshed.")}
            </p>
          )}
          {incomingCompleted.map((item) => (
            <IncomingIntentRow key={item.id} item={item} />
          ))}
        </section>
      )}
      {showOutgoingState && (
        <OutgoingQueryState
          loading={outgoingLoading}
          error={outgoingUnavailable}
          onRetry={() => void outgoing.refetch()}
        />
      )}
      {outgoingReady.length > 0 && (
        <section className="card">
          <div className="panel-heading">
            <h2>Ready to send</h2>
          </div>
          {outgoing.error && (
            <p className="field-help" role="alert">
              {errorText(outgoing.error, "Ready sends could not be refreshed.")}
            </p>
          )}
          {outgoingReady.map((item) => (
            <ReadyIntentRow key={item.id} item={item} />
          ))}
        </section>
      )}
    </div>
  );
}
