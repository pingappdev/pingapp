import { useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useCancelIntent, useIncomingIntents, useIntents } from "../../api/hooks";
import type { Intent } from "../../api/types";
import TokenIcon from "../components/TokenIcon";
import { IntentCard, IncomingIntentRow, QueryMessage } from "./requests/IntentRows";
import { dateLabel } from "./requests/utils";
import EscrowLists from "./requests/EscrowLists";

function smsStatusLabel(intent: Intent): string {
  switch (intent.smsStatus) {
    case "sent":
      return "SMS sent";
    case "skipped_rate_limit":
      return "SMS skipped because this number was texted recently";
    case "disabled":
      return "SMS is disabled";
    case "failed":
      return "SMS could not be sent";
  }
}

export default function Requests() {
  const intents = useIntents("all");
  const incoming = useIncomingIntents();
  const cancelIntent = useCancelIntent();
  const cancelInFlight = useRef(false);
  const [cancelTarget, setCancelTarget] = useState<Intent | null>(null);

  const openIntents = (intents.data ?? []).filter(
    (intent) => intent.status === "pending" || intent.status === "ready",
  );
  const readyIntents = openIntents.filter((intent) => intent.status === "ready");
  const pendingIntents = openIntents.filter((intent) => intent.status === "pending");
  const historyIntents = (intents.data ?? []).filter(
    (intent) =>
      intent.status === "completed" || intent.status === "cancelled" || intent.status === "expired",
  );

  async function confirmCancel() {
    if (!cancelTarget || cancelIntent.isPending || cancelInFlight.current) return;
    cancelInFlight.current = true;
    try {
      await cancelIntent.mutateAsync(cancelTarget.id);
      toast.success("Pending send canceled");
      setCancelTarget(null);
    } catch (reason) {
      toast.error((reason as Error).message || "Could not cancel this pending send.");
    } finally {
      cancelInFlight.current = false;
    }
  }

  const intentsLoading = intents.isPending && !intents.data;
  const intentsError = intents.isError && !intents.data;
  const incomingLoading = incoming.isPending && !incoming.data;
  const incomingError = incoming.isError && !incoming.data;

  return (
    <div className="request-page">
      <EscrowLists />
      <a className="button accent" href="/dashboard/send">
        Send by phone
      </a>

      {intentsLoading || intentsError ? (
        <section className="card">
          <QueryMessage
            title="Invitations"
            loading={intentsLoading}
            error={intents.error}
            onRetry={() => void intents.refetch()}
          />
        </section>
      ) : (
        <>
          {intents.isError && (
            <div className="request-inline-query-error" role="status">
              Showing saved results.{" "}
              <button className="text-link" type="button" onClick={() => void intents.refetch()}>
                Refresh
              </button>
            </div>
          )}
          {readyIntents.length > 0 && (
            <section className="card request-list-card">
              <div className="panel-heading">
                <div>
                  <h2>Unfunded invitations</h2>
                  <p className="field-help">
                    No funds have been sent or reserved for these invitations. Cancel an invitation
                    or start a new send by phone.
                  </p>
                </div>
                <span className="pill">{readyIntents.length}</span>
              </div>
              <div className="request-intent-list">
                {readyIntents.map((intent) => (
                  <IntentCard
                    key={intent.id}
                    intent={intent}
                    readOnly
                    onCancel={setCancelTarget}
                    canceling={cancelIntent.isPending}
                  />
                ))}
              </div>
            </section>
          )}

          {pendingIntents.length > 0 && (
            <section className="card request-list-card">
              <div className="panel-heading">
                <div>
                  <h2>Invitations awaiting signup</h2>
                  <p className="field-help">These invites do not reserve funds or move crypto.</p>
                </div>
                <span className="pill">{pendingIntents.length}</span>
              </div>
              <div className="request-intent-list">
                {pendingIntents.map((intent) => (
                  <div className="request-pending-item" key={intent.id}>
                    <IntentCard
                      intent={intent}
                      readOnly
                      onCancel={setCancelTarget}
                      canceling={cancelIntent.isPending}
                    />
                    <p className="request-sms-status">
                      <span>{smsStatusLabel(intent)}</span>
                      <a href={intent.claimUrl} target="_blank" rel="noreferrer">
                        Open invite <ExternalLink size={13} />
                      </a>
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {incomingLoading || incomingError ? (
        <section className="card">
          <QueryMessage
            title="Incoming invitations"
            loading={incomingLoading}
            error={incoming.error}
            onRetry={() => void incoming.refetch()}
          />
        </section>
      ) : incoming.data?.length ? (
        <section className="card request-list-card">
          <div className="panel-heading">
            <div>
              <h2>Incoming invitations</h2>
              <p className="field-help">
                No funds have been sent or reserved. The sender needs to start a new send by phone.
              </p>
            </div>
            <span className="pill">{incoming.data?.length ?? 0}</span>
          </div>
          <div className="request-intent-list">
            {incoming.data.map((intent) => (
              <IncomingIntentRow key={intent.id} intent={intent} />
            ))}
          </div>
        </section>
      ) : null}

      {historyIntents.length > 0 && (
        <details className="card request-history">
          <summary>
            <span>Invitation history</span>
            <span>{historyIntents.length}</span>
          </summary>
          <div className="request-intent-list">
            {historyIntents.map((intent) => (
              <article className="request-intent-row" key={intent.id}>
                <div className="request-intent-main">
                  <TokenIcon symbol={intent.token.symbol} logoUrl={intent.token.logoUrl} />
                  <div>
                    <strong>
                      {intent.amount} {intent.token.symbol} · {intent.recipientPhoneMasked}
                    </strong>
                    <small>
                      {intent.status === "completed"
                        ? `Completed ${dateLabel(intent.completedAt ?? intent.createdAt)}`
                        : `${intent.status === "cancelled" ? "Canceled" : "Expired"} · ${dateLabel(intent.createdAt)}`}
                    </small>
                  </div>
                </div>
                <div className="request-intent-actions">
                  <span className={`pill status-pill status-${intent.status}`}>
                    {intent.status === "cancelled"
                      ? "Canceled"
                      : intent.status[0].toUpperCase() + intent.status.slice(1)}
                  </span>
                  {intent.status === "completed" && intent.transferId && (
                    <a
                      className="button outline"
                      href={`/dashboard/activity?transfer=${encodeURIComponent(intent.transferId)}`}
                    >
                      View activity <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        </details>
      )}

      <AlertDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => {
          if (!open && !cancelIntent.isPending && !cancelInFlight.current) setCancelTarget(null);
        }}
      >
        <AlertDialogContent className="workspace-alert">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this pending send?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelTarget?.status === "ready"
                ? "The sender will no longer be able to complete this pending send. Nothing has been sent yet."
                : "The invite will stop working. Nothing has been sent and no crypto is held."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelIntent.isPending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="button accent"
              disabled={cancelIntent.isPending}
              onClick={(event) => {
                event.preventDefault();
                void confirmCancel();
              }}
            >
              {cancelIntent.isPending ? "Canceling…" : "Cancel pending send"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
