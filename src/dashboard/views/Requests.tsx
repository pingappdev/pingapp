import { useEffect, useRef, useState } from "react";
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
import { useSearchParams } from "../../routing";
import TokenIcon from "../components/TokenIcon";
import { IntentCard, IncomingIntentRow, QueryMessage, EmptyIntents } from "./requests/IntentRows";
import IntentForm from "./requests/IntentForm";
import { dateLabel } from "./requests/utils";

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
  const params = useSearchParams();
  const intents = useIntents("all");
  const incoming = useIncomingIntents();
  const cancelIntent = useCancelIntent();
  const cancelInFlight = useRef(false);
  const [formOpen, setFormOpen] = useState(params.get("new") === "1");
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

  useEffect(() => {
    if (params.get("new") === "1") setFormOpen(true);
  }, [params]);

  useEffect(() => {
    if (intents.isSuccess && intents.data.length === 0) setFormOpen(true);
  }, [intents.data, intents.isSuccess]);

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
      <IntentForm open={formOpen} onOpenChange={setFormOpen} />

      {intentsLoading || intentsError ? (
        <section className="card">
          <QueryMessage
            title="Pending sends"
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
          <section className="card request-list-card">
            <div className="panel-heading">
              <div>
                <h2>Ready to send</h2>
                <p className="field-help">
                  Recipients linked the invited phone. Review and approve each transfer in your
                  wallet.
                </p>
              </div>
              <span className="pill">{readyIntents.length}</span>
            </div>
            {readyIntents.length ? (
              <div className="request-intent-list">
                {readyIntents.map((intent) => (
                  <IntentCard
                    key={intent.id}
                    intent={intent}
                    onCancel={setCancelTarget}
                    canceling={cancelIntent.isPending}
                  />
                ))}
              </div>
            ) : (
              <EmptyIntents kind="ready" />
            )}
          </section>

          <section className="card request-list-card">
            <div className="panel-heading">
              <div>
                <h2>Waiting for signup</h2>
                <p className="field-help">These invites do not reserve funds or move crypto.</p>
              </div>
              <span className="pill">{pendingIntents.length}</span>
            </div>
            {pendingIntents.length ? (
              <div className="request-intent-list">
                {pendingIntents.map((intent) => (
                  <div className="request-pending-item" key={intent.id}>
                    <IntentCard
                      intent={intent}
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
            ) : (
              <EmptyIntents kind="pending" />
            )}
          </section>
        </>
      )}

      {incomingLoading || incomingError ? (
        <section className="card">
          <QueryMessage
            title="Incoming sends"
            loading={incomingLoading}
            error={incoming.error}
            onRetry={() => void incoming.refetch()}
          />
        </section>
      ) : (
        <section className="card request-list-card">
          <div className="panel-heading">
            <div>
              <h2>People waiting to send you</h2>
              <p className="field-help">
                Pending sends become transfers only after the sender approves them in their wallet.
              </p>
            </div>
            <span className="pill">{incoming.data?.length ?? 0}</span>
          </div>
          {incoming.data?.length ? (
            <div className="request-intent-list">
              {incoming.data.map((intent) => (
                <IncomingIntentRow key={intent.id} intent={intent} />
              ))}
            </div>
          ) : (
            <EmptyIntents kind="incoming" />
          )}
        </section>
      )}

      <details className="card request-history">
        <summary>
          <span>History</span>
          <span>{historyIntents.length}</span>
        </summary>
        {intents.isPending && !intents.data ? (
          <QueryMessage
            title="History"
            loading
            error={null}
            onRetry={() => void intents.refetch()}
          />
        ) : intents.isError && !intents.data ? (
          <QueryMessage
            title="History"
            loading={false}
            error={intents.error}
            onRetry={() => void intents.refetch()}
          />
        ) : historyIntents.length ? (
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
        ) : (
          <p className="request-empty">
            Completed, canceled, and expired pending sends will appear here.
          </p>
        )}
      </details>

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
