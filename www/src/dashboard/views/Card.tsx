import { useRefreshApp } from "@/platform/useRefreshApp";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, Eye, Plus, Smartphone } from "lucide-react";
import { useCards, useCardsConfig, useCardTransactions, type CardSummary } from "@/api/cards";
import { useAuth } from "@/auth/useAuth";
import { ApplePayDialog } from "./cards/ApplePayDialog";
import { CardApplication } from "./cards/CardApplication";
import { CardDetailsDialog } from "./cards/CardDetailsDialog";
import { CardFace } from "./cards/CardFace";
import { CardOperationPanel } from "./cards/CardOperationPanel";
import { CardSetupPanel } from "./cards/CardSetupPanel";
import { cardNeedsAction, cardStage, cardStageLabel } from "./cards/cardStage";
import { useCardRequest } from "./cards/useCardRequest";
import { useCardLiveState } from "./cards/useCardLiveState";
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
  const refreshApp = useRefreshApp();
  const request = useCardRequest(userId);
  const configQuery = useCardsConfig(userId, !request.accountChanged);
  const cardsQuery = useCards(userId, !request.accountChanged);
  const config = configQuery.data;
  const [modal, setModal] = useState<"issue" | "topup" | "details" | "applePay" | null>(null);
  // Card details opened from the Apple Pay steps return to those steps when closed.
  const [detailsFromApplePay, setDetailsFromApplePay] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const live = useCardLiveState(
    userId,
    cardsQuery.data ?? [],
    request.accepted,
    !request.accountChanged,
  );
  const cards = [...live.cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const card =
    cards.find((item) => item.id === selectedId) ??
    cards.find((item) => item.issueStatus !== "failed") ??
    cards[0];
  const issued = card?.issueStatus === "issued";
  const ownedProducts = cards
    .filter((item) => item.issueStatus !== "failed")
    .map((item) => item.product);
  const availableProducts =
    config?.products.filter((item) => !ownedProducts.includes(item.id)) ?? [];
  const canCreate = cardsQuery.isSuccess && availableProducts.length > 0;
  const supported = Boolean(config?.enabled && config.networks.length);
  // Each card shows its own latest request inside its view; only requests whose card
  // is not loaded yet fall back to a standalone panel.
  const observationFor = (id: string) =>
    live.observations.find(({ operation }) => operation.cardId === id);
  const orphanOperations = live.observations.filter(
    ({ operation }) =>
      !cards.some((item) => item.id === operation.cardId) &&
      !(operation.kind === "issue" && operation.status === "completed"),
  );
  const canMutate = supported && !request.busy && !request.pending;
  const pendingTopup = live.observations.some(
    ({ operation }) =>
      operation.cardId === card?.id &&
      operation.status !== "completed" &&
      operation.status !== "failed",
  );
  const canTopup = issued && canMutate && !pendingTopup;
  const observation = card ? observationFor(card.id) : undefined;
  const stage = card ? cardStage(card, observation?.operation) : null;
  const cardName = (item: CardSummary) =>
    config?.products.find((product) => product.id === item.product)?.name ??
    statusLabel(item.product);
  const productNetwork = (item: CardSummary) =>
    config?.products.find((product) => product.id === item.product)?.network ?? item.network;
  const cardNetwork = card ? productNetwork(card) : "";
  const railRef = useRef<HTMLDivElement>(null);
  const selectCard = (id: string) => {
    setSelectedId(id);
    setModal(null);
  };
  useEffect(() => {
    if (request.accepted?.cardId) setSelectedId(request.accepted.cardId);
  }, [request.accepted?.cardId]);
  const refresh = () => {
    void cardsQuery.refetch();
    void configQuery.refetch();
  };

  if (request.accountChanged)
    return (
      <section className="card card-recovery" role="alert">
        <h2>Your signed-in account changed</h2>
        <p>
          Refresh your session before continuing. To recover this application, switch back to the
          account that started it. Any pending request remains saved for that account.
        </p>
        <button type="button" className="button outline" onClick={refreshApp}>
          Refresh session
        </button>
      </section>
    );

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
        <section className="pc-empty">
          <CardFace
            product={config?.products[0]?.id ?? "visa"}
            name={config?.products[0]?.name ?? "Ping Card"}
            network={config?.products[0]?.network ?? "Visa"}
          />
          <div>
            <h2>Spend your crypto anywhere cards work</h2>
            <p>
              Pick a virtual card and fund it with USDT. Card funds stay separate from your wallet.
            </p>
            {config?.products.length === 1 && config.products[0].issuePriceUsd != null && (
              <p>
                Issue price: <strong>{usd(config.products[0].issuePriceUsd)}</strong>
              </p>
            )}
            <p className="field-help">We only ask for a contact email when you create a card.</p>
            <button
              className="button accent"
              type="button"
              disabled={!canMutate || !canCreate}
              onClick={() => setModal("issue")}
            >
              <Plus size={17} /> Create card
            </button>
          </div>
        </section>
      )}
      {card && (
        <>
          <section className="pc-wallet" aria-labelledby="pc-wallet-title">
            <div className="pc-wallet-head">
              <h2 id="pc-wallet-title">
                Your cards <span>({String(cards.length).padStart(2, "0")})</span>
              </h2>
              {canCreate && (
                <button
                  type="button"
                  className="button outline small"
                  disabled={!canMutate}
                  onClick={() => setModal("issue")}
                >
                  <Plus size={16} /> New card
                </button>
              )}
            </div>
            <div
              className="pc-rail"
              role="radiogroup"
              aria-labelledby="pc-wallet-title"
              onKeyDown={(event) => {
                const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
                if (!step) return;
                event.preventDefault();
                const next =
                  cards[
                    (cards.findIndex((item) => item.id === card.id) + step + cards.length) %
                      cards.length
                  ];
                selectCard(next.id);
                railRef.current?.querySelector<HTMLElement>(`[data-card-id="${next.id}"]`)?.focus();
              }}
              ref={railRef}
            >
              {cards.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={item.id === card.id}
                  tabIndex={item.id === card.id ? 0 : -1}
                  data-card-id={item.id}
                  className="pc-rail-item"
                  aria-label={[
                    cardName(item),
                    item.last4 ? `ending ${item.last4}` : null,
                    cardStageLabel(item, observationFor(item.id)?.operation),
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  onClick={() => selectCard(item.id)}
                >
                  <CardFace
                    product={item.product}
                    name={cardName(item)}
                    network={productNetwork(item)}
                    last4={item.last4}
                    status={item.issueStatus}
                    statusText={cardStageLabel(item, observationFor(item.id)?.operation)}
                    frozen={item.frozen}
                  />
                  {cardNeedsAction(item, observationFor(item.id)?.operation) && (
                    <span className="pc-rail-attention" aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          </section>
          {stage?.kind === "setup" ? (
            <CardSetupPanel
              key={card.id}
              card={card}
              name={cardName(card)}
              stage={stage.stage}
              operation={observation?.operation}
              config={config}
              refreshing={observation?.refreshing ?? cardsQuery.isFetching}
              refreshError={observation?.refreshError ?? false}
              onRefresh={() => {
                observation?.refresh();
                void cardsQuery.refetch();
              }}
              onRestart={canCreate && canMutate ? () => setModal("issue") : null}
            />
          ) : (
            <div className="pc-detail">
              <section className="pc-summary" aria-label={`${cardName(card)} summary`}>
                <div className="pc-summary-head">
                  <h2>{cardName(card)}</h2>
                  <span className="pc-status" data-tone={cardTone(card)}>
                    {cardState(card)}
                  </span>
                </div>
                <p className="pc-balance-label">
                  {config?.sandbox ? "Test card balance" : "Card balance"}
                </p>
                <div className="pc-balance">{usd(card.balanceUsd)}</div>
                <p className="pc-balance-meta">
                  {card.balanceAsOf
                    ? `Updated ${dateTime(card.balanceAsOf)}`
                    : "Balance freshness unavailable"}
                </p>
                {live.refreshingBalances.has(card.id) && (
                  <p className="pc-balance-meta" role="status">
                    Top-up confirmed. Refreshing the provider balance…
                  </p>
                )}
                {card.pendingTopupUsd != null && Number(card.pendingTopupUsd) > 0 && (
                  <p className="pc-balance-meta">Pending top-up: {usd(card.pendingTopupUsd)}</p>
                )}
                <div className="pc-actions">
                  <button
                    type="button"
                    className="button accent"
                    disabled={!canTopup}
                    onClick={() => setModal("topup")}
                  >
                    <Plus size={17} /> Top up
                  </button>
                  <button
                    type="button"
                    className="button outline"
                    disabled={!issued}
                    onClick={() => setModal("details")}
                  >
                    <Eye size={17} /> Card details
                  </button>
                  {card.product === "mastercard" && (
                    <button
                      type="button"
                      className="button outline"
                      disabled={!issued}
                      onClick={() => setModal("applePay")}
                    >
                      <Smartphone size={17} /> Add to Apple Pay
                    </button>
                  )}
                </div>
                {observation?.operation.kind === "topup" && (
                  <CardOperationPanel
                    operation={observation.operation}
                    refreshing={observation.refreshing}
                    refreshError={observation.refreshError}
                    onRefresh={observation.refresh}
                    cardLabel=""
                    config={config}
                  />
                )}
                <dl className="pc-info">
                  <InfoRow label="Network" value={cardNetwork} />
                  <InfoRow label="Currency" value={card.currency} />
                  <InfoRow label="Issued" value={dateTime(card.issuedAt)} />
                  <InfoRow label="Funding" value="USDT via provider invoice" />
                </dl>
                <p className="field-help">
                  Card funds are held by the card provider once credit is confirmed, separate from
                  your wallet balance.
                </p>
              </section>
              <div className="pc-activity">
                <section className="pc-spending">
                  <div className="panel-heading">
                    <h2>Spent this month</h2>
                  </div>
                  {card.monthlySpending.complete && card.monthlySpending.amountUsd !== null ? (
                    <strong className="pc-spending-amount">
                      {usd(card.monthlySpending.amountUsd)}
                    </strong>
                  ) : (
                    <p className="field-help">
                      Monthly spending appears once the provider supplies complete history.
                    </p>
                  )}
                </section>
                <Transactions key={card.id} userId={userId} card={card} />
              </div>
            </div>
          )}
        </>
      )}
      {orphanOperations.length > 0 && (
        <div className="card-operations card-full-width">
          {orphanOperations.map(({ operation, refreshing, refreshError, refresh }) => (
            <CardOperationPanel
              key={operation.id}
              operation={operation}
              refreshing={refreshing}
              refreshError={refreshError}
              onRefresh={refresh}
              cardLabel={
                cards.find((item) => item.id === operation.cardId)
                  ? cardName(cards.find((item) => item.id === operation.cardId)!)
                  : "Card request"
              }
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
          ownedProducts={ownedProducts}
          busy={request.busy}
          available={modal === "issue" ? canMutate && canCreate : canTopup}
          error={request.error}
          onClose={() => setModal(null)}
          onSubmit={async (input) => {
            if (
              !canMutate ||
              (modal === "issue"
                ? !canCreate || ownedProducts.includes(input.product)
                : !canTopup || !card)
            )
              return;
            const accepted = await request.submit(
              modal === "issue"
                ? {
                    kind: "issue",
                    email: input.email,
                    cardholderName: input.cardholderName,
                    product: input.product,
                    network: input.network,
                  }
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
          onClose={() => {
            setModal(detailsFromApplePay ? "applePay" : null);
            setDetailsFromApplePay(false);
          }}
        />
      )}
      {modal === "applePay" && card && issued && card.product === "mastercard" && (
        <ApplePayDialog
          key={card.id}
          cardId={card.id}
          last4={card.last4}
          available={Boolean(config?.capabilities.applePay)}
          withReauth={withReauth}
          onShowDetails={() => {
            setDetailsFromApplePay(true);
            setModal("details");
          }}
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
    <section className="pc-transactions">
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

function cardState(card: CardSummary) {
  if (card.issueStatus !== "issued") return statusLabel(card.issueStatus);
  if (card.frozen === true) return "Frozen";
  return card.frozen === null ? "Issued" : "Active";
}

function cardTone(card: CardSummary) {
  if (card.issueStatus === "failed") return "error";
  if (card.issueStatus !== "issued" || card.frozen === true) return "muted";
  return "ok";
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
