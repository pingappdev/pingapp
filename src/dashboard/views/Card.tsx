import { useState } from "react";
import { ArrowDown, ArrowUpRight, CreditCard, Plus, Snowflake } from "lucide-react";
import {
  isOperationPending,
  useCards,
  useCardsConfig,
  useCardTransactions,
  type CardSummary,
  type CardOperation,
} from "@/api/cards";
import { useAuth } from "@/auth/useAuth";
import { CardApplication } from "./cards/CardApplication";
import { CardDetailsDialog } from "./cards/CardDetailsDialog";
import { CardOperationPanel } from "./cards/CardOperationPanel";
import { useCardRequest } from "./cards/useCardRequest";
import { readCardRequest } from "./cards/requests";
import { dateTime, statusLabel, usd } from "./cards/format";
import "./card.css";

export default function Card() {
  const auth = useAuth();
  if (auth.status !== "signed-in" || !auth.me)
    return <p role="status">Sign in to view your cards.</p>;
  // Account changes unmount all forms and sensitive local state immediately.
  return <CardDashboard key={auth.me.id} userId={auth.me.id} withReauth={auth.withReauth} />;
}

function CardDashboard({
  userId,
  withReauth,
}: {
  userId: string;
  withReauth: ReturnType<typeof useAuth>["withReauth"];
}) {
  const configQuery = useCardsConfig(userId);
  const cardsQuery = useCards(userId);
  const config = configQuery.data;
  const request = useCardRequest(userId);
  const [modal, setModal] = useState<"issue" | "topup" | "details" | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const cards = [...(cardsQuery.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const card =
    cards.find((item) => item.id === selectedId) ??
    cards.find((item) => item.issueStatus !== "failed") ??
    cards[0];
  const issued = card?.issueStatus === "issued";
  const canCreate = Boolean(
    cardsQuery.isSuccess && cards.every((item) => item.issueStatus === "failed"),
  );
  const supported = Boolean(
    config?.enabled && config.products.some((item) => item.id === "visa") && config.networks.length,
  );
  const operations = new Map<string, CardOperation>();
  for (const item of cards)
    if (item.latestOperation) operations.set(item.latestOperation.id, item.latestOperation);
  if (request.accepted) {
    const latest = cards.find((item) => item.id === request.accepted?.cardId)?.latestOperation;
    const existing = operations.get(request.accepted.id);
    if (
      (!latest || request.accepted.createdAt >= latest.createdAt) &&
      (!existing || request.accepted.updatedAt > existing.updatedAt)
    )
      operations.set(request.accepted.id, request.accepted);
  }
  const visibleOperations = [...operations.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const pendingOperation = visibleOperations.some((operation) => isOperationPending(operation));
  const canMutate = supported && !request.busy && !request.pending && !pendingOperation;
  const refresh = () => {
    void cardsQuery.refetch();
    void configQuery.refetch();
  };

  return (
    <div className="card-view">
      {config?.sandbox && (
        <div className="card-preview-note">
          <span>Sandbox</span>
          <p>Test cards and simulated funds. Do not send real money to these invoices.</p>
        </div>
      )}
      {(configQuery.isPending || cardsQuery.isPending) && (
        <p className="card-full-width" role="status">
          Loading your card account…
        </p>
      )}
      {(configQuery.isError || cardsQuery.isError) && (
        <div className="card card-full-width" role="alert">
          <p>
            Could not load {cardsQuery.isError ? "your cards" : "card availability"}.{" "}
            {cardsQuery.data
              ? "Previously loaded information is shown."
              : "Please retry to check your account."}
          </p>
          <button type="button" className="button outline" onClick={refresh}>
            Retry
          </button>
        </div>
      )}
      {config && !supported && (
        <p className="card-full-width field-help">
          New card invoices are currently unavailable. Existing requests remain visible below.
        </p>
      )}
      {request.error && !modal && (
        <p className="card-full-width card-error" role="alert">
          {request.error}
        </p>
      )}
      {request.pending && (
        <section className="card card-full-width card-recovery">
          <h2>Confirm your previous request</h2>
          <p>
            The outcome of your {request.pending.kind === "issue" ? "card application" : "top-up"}{" "}
            request is not yet confirmed. Recover the same request before starting another. Do not
            send a second payment.
          </p>
          <p className="field-help">
            {config?.networks.find((item) => item.id === request.pending?.input.network)?.label ??
              request.pending.input.network}
            {request.pending.kind === "topup" ? ` · ${usd(request.pending.input.amountUsd)}` : ""}
          </p>
          <small>Request reference: {request.pending.input.requestId}</small>
          <button
            type="button"
            className="button outline"
            disabled={request.busy}
            onClick={() => void request.submit()}
          >
            {request.busy ? "Recovering…" : "Recover request"}
          </button>
        </section>
      )}
      {cardsQuery.isSuccess && !card && (
        <section className="card card-empty card-full-width">
          <span className="card-action-icon">
            <CreditCard size={28} />
          </span>
          <h2>Your everyday card</h2>
          <p>Create a virtual Visa card and fund it with USDT on an available network.</p>
          <p className="field-help">
            Your contact email is only requested when you choose to create a card.
          </p>
          {config?.products.find((item) => item.id === "visa")?.issuePriceUsd != null && (
            <p>
              Issue price:{" "}
              <strong>
                {usd(config.products.find((item) => item.id === "visa")!.issuePriceUsd)}
              </strong>
            </p>
          )}
          <button
            className="button accent"
            type="button"
            disabled={!canMutate || !canCreate}
            onClick={() => setModal("issue")}
          >
            <Plus size={17} /> Create card
          </button>
        </section>
      )}
      {card && (
        <>
          <div className="card-overview">
            {cards.length > 1 && (
              <label className="card-field">
                Card
                <select
                  value={card.id}
                  onChange={(event) => {
                    setSelectedId(event.target.value);
                    setModal(null);
                  }}
                >
                  {cards.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.last4 ? `•••• ${item.last4}` : "Card application"} ·{" "}
                      {statusLabel(item.issueStatus)} · {dateTime(item.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div
              className={"ping-card-visual" + (card.frozen === true ? " frozen" : "")}
              aria-label={`Virtual ${card.network} card ${card.last4 ? `ending ${card.last4}` : "awaiting details"}`}
            >
              <span className="ping-card-shine" />
              <span className="ping-card-inner">
                <span className="ping-card-top">
                  <span className="ping-card-brand">
                    <span className="ping-card-mark" />
                    <strong>Ping</strong>
                  </span>
                  {card.frozen === true ? (
                    <span className="ping-card-frozen">
                      <Snowflake size={10} /> FROZEN
                    </span>
                  ) : (
                    <span className="ping-card-network">{card.network}</span>
                  )}
                </span>
                <span className="ping-card-number">•••• •••• •••• {card.last4 ?? "••••"}</span>
                <span className="ping-card-row">
                  <span>
                    <small>EXPIRES</small>
                    <span>••/••</span>
                  </span>
                  <span>
                    <small>CVV</small>
                    <span>•••</span>
                  </span>
                  <span className="ping-card-wave" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                </span>
              </span>
            </div>
            <div className="card-balance-block">
              <span className="eyebrow">
                {config?.sandbox ? "TEST CARD BALANCE" : "CARD BALANCE"}
              </span>
              <div className="card-balance-amount">{usd(card.balanceUsd)}</div>
              <p className="field-help">
                {card.balanceAsOf
                  ? `Updated ${dateTime(card.balanceAsOf)}`
                  : "Balance freshness unavailable"}
              </p>
              {card.pendingTopupUsd != null && (
                <p className="field-help">Pending top-up: {usd(card.pendingTopupUsd)}</p>
              )}
            </div>
            <p className="card-account-status">
              Status: <strong>{statusLabel(card.issueStatus)}</strong> ·{" "}
              {card.frozen === null
                ? "Freeze status unavailable"
                : card.frozen
                  ? "Frozen"
                  : "Not frozen"}
            </p>
            <div className="card-actions">
              <button
                type="button"
                disabled={!issued || !canMutate}
                onClick={() => setModal("topup")}
              >
                <span className="card-action-icon">
                  <Plus size={20} />
                </span>
                <small>Top up</small>
              </button>
              <button type="button" disabled={!issued} onClick={() => setModal("details")}>
                <span className="card-action-icon">
                  <CreditCard size={20} />
                </span>
                <small>Details</small>
              </button>
            </div>
            {!issued && (
              <p className="field-help">
                Top-up and details become available when the provider confirms this card is issued.
              </p>
            )}
            {canCreate && (
              <button
                type="button"
                className="button accent"
                disabled={!canMutate}
                onClick={() => setModal("issue")}
              >
                Create card
              </button>
            )}
          </div>
          <div className="card-activity">
            <section className="card card-spending">
              <div className="panel-heading">
                <h2>Spending</h2>
                <span className="card-spending-period">This month</span>
              </div>
              {card.monthlySpending.complete && card.monthlySpending.amountUsd !== null ? (
                <div className="card-spending-labels">
                  <strong>{usd(card.monthlySpending.amountUsd)} spent</strong>
                </div>
              ) : (
                <p className="field-help">
                  Monthly spending is unavailable until the provider supplies complete history.
                </p>
              )}
            </section>
            <Transactions key={card.id} userId={userId} card={card} />
          </div>
          <section className="card card-info-block">
            <div className="panel-heading">
              <h2>Card info</h2>
            </div>
            <InfoRow label="Type" value={`Virtual · ${card.product}`} />
            <InfoRow label="Network" value={card.network} />
            <InfoRow label="Currency" value={card.currency} />
            <InfoRow label="Issued" value={dateTime(card.issuedAt)} />
            <InfoRow label="Funding" value="Provider invoices · USDT" />
            <p className="field-help card-full-width">
              Card funds are held through the card provider after credit is confirmed. They are
              separate from your connected wallet balance.
            </p>
          </section>
        </>
      )}
      {visibleOperations.length > 0 && (
        <div className="card-operations card-full-width">
          {visibleOperations.map((operation) => (
            <CardOperationPanel
              key={operation.id}
              userId={userId}
              initial={operation}
              config={config}
            />
          ))}
        </div>
      )}
      {(modal === "issue" || modal === "topup") && config && (
        <CardApplication
          key={`${modal}:${card?.id ?? "new"}`}
          config={config}
          kind={modal}
          busy={request.busy}
          available={canMutate && (modal === "issue" ? canCreate : issued)}
          error={request.error}
          onClose={() => setModal(null)}
          onSubmit={async (input) => {
            if (!canMutate || (modal === "issue" ? !canCreate : !issued || !card)) return;
            const accepted = await request.submit(
              modal === "issue"
                ? { kind: "issue", email: input.email, network: input.network }
                : {
                    kind: "topup",
                    cardId: card!.id,
                    network: input.network,
                    amountUsd: input.amountUsd,
                  },
            );
            if (accepted || readCardRequest(userId)) setModal(null);
          }}
        />
      )}
      {modal === "details" && card && issued && (
        <CardDetailsDialog
          key={card.id}
          userId={userId}
          cardId={card.id}
          last4={card.last4}
          withReauth={withReauth}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function Transactions({ userId, card }: { userId: string; card: CardSummary }) {
  const query = useCardTransactions(userId, card.id, card.issueStatus === "issued");
  const items = [
    ...new Map(
      (query.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item]),
    ).values(),
  ];
  return (
    <section className="card card-tx-list">
      <div className="panel-heading">
        <h2>Recent transactions</h2>
      </div>
      {card.issueStatus !== "issued" ? (
        <p className="field-help">Transactions will be available after issuance.</p>
      ) : (
        <>
          {query.isPending && (
            <p role="status" className="field-help">
              Loading transactions…
            </p>
          )}
          {query.isError && (
            <div role="alert">
              <p className="card-error">Could not load transactions.</p>
              <button type="button" className="button outline" onClick={() => void query.refetch()}>
                Retry transactions
              </button>
            </div>
          )}
          {query.isSuccess && items.length === 0 && (
            <p className="field-help">No transactions reported yet.</p>
          )}
          {query.data?.pages.some((page) => !page.complete) && (
            <p className="field-help">
              Provider history is incomplete. These entries may not include all activity.
            </p>
          )}
          {items.map((item) => (
            <div className="card-tx-row" key={item.id}>
              <span className={`card-tx-icon ${item.direction === "credit" ? "success" : "muted"}`}>
                {item.direction === "credit" ? <ArrowDown size={16} /> : <ArrowUpRight size={16} />}
              </span>
              <div>
                <strong>{item.merchant ?? statusLabel(item.type)}</strong>
                <small>
                  {dateTime(item.occurredAt)} · {statusLabel(item.status)}
                </small>
              </div>
              <span className={`card-tx-amount${item.direction === "credit" ? " positive" : ""}`}>
                {item.direction === "credit" ? "+" : "−"}
                {item.currency === "USD"
                  ? usd(item.amount.replace(/^-/, ""))
                  : `${item.amount.replace(/^-/, "")} ${item.currency}`}
              </span>
            </div>
          ))}
          {query.hasNextPage && (
            <button
              className="button outline"
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="card-info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
