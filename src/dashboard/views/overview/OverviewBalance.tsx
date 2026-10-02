import { useState, type FormEvent } from "react";
import { isValidPhoneNumber } from "libphonenumber-js";
import { ArrowDownLeft, ArrowUpRight, Lock, RefreshCw, Send } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { sessionRevision, useBalances, qk } from "../../../api/hooks";
import type { Me } from "../../../api/types";
import { useAuth } from "../../../auth/useAuth";
import { useDashboard } from "../../state";
import { navigateTo } from "../../../navigation";
import AddressText from "../../components/AddressText";
import Amount from "../../components/Amount";
import Usd from "../../components/Usd";
import PhoneInput from "../../components/PhoneInput";
import { Skeleton } from "@/components/ui/skeleton";

export default function OverviewBalance() {
  const { me } = useAuth();
  const { setModal } = useDashboard();
  const queryClient = useQueryClient();
  const balances = useBalances();
  const refreshBalances = useBalances({ refresh: true, enabled: false });
  const [recipient, setRecipient] = useState("");
  const validRecipient = /^\+\d+$/.test(recipient) && isValidPhoneNumber(recipient);
  const [refreshError, setRefreshError] = useState<Error | null>(null);

  const eth = balances.data?.items.find((asset) => asset.token.symbol === "ETH");
  const refreshing = refreshBalances.isFetching;
  const balanceError = balances.error instanceof Error ? balances.error : refreshError;

  async function refreshPortfolio() {
    const expectedRevision = sessionRevision(queryClient);
    const expectedIdentity = me ? { id: me.id, address: me.address.toLowerCase() } : null;
    const cachedSession = queryClient.getQueryData<Me | null>(qk.session);
    if (
      !expectedIdentity ||
      !cachedSession ||
      cachedSession.id !== expectedIdentity.id ||
      cachedSession.address.toLowerCase() !== expectedIdentity.address
    )
      return;

    setRefreshError(null);
    const result = await refreshBalances.refetch();

    const currentSession = queryClient.getQueryData<Me | null>(qk.session);
    if (
      sessionRevision(queryClient) !== expectedRevision ||
      !currentSession ||
      currentSession.id !== expectedIdentity.id ||
      currentSession.address.toLowerCase() !== expectedIdentity.address
    )
      return;

    if (result.error instanceof Error) {
      setRefreshError(result.error);
      return;
    }
    if (result.data) queryClient.setQueryData(qk.balances(false), result.data);
  }

  function continueToSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validRecipient) return;
    navigateTo(`/dashboard/send?to=${encodeURIComponent(recipient)}`);
  }

  return (
    <>
      <div className="overview-grid">
        <section className="balance-card">
          <div className="card-top">
            <span>PORTFOLIO VALUE</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh portfolio balances"
              title="Refresh balances"
              disabled={refreshing}
              onClick={() => void refreshPortfolio()}
            >
              <RefreshCw size={16} className={refreshing ? "spin" : undefined} />
            </button>
          </div>
          <div className="balance-number" aria-live="polite">
            {balances.isPending && !balances.data ? (
              <div>
                <Skeleton className="h-12 w-52" />
              </div>
            ) : balances.data?.totalUsd !== null && balances.data?.totalUsd !== undefined ? (
              <div>
                <Usd value={balances.data.totalUsd} />
              </div>
            ) : eth ? (
              <div>
                <Amount value={eth.balance} symbol="ETH" />
              </div>
            ) : (
              "—"
            )}
          </div>
          <p className="balance-caption">
            ETH {eth?.balance ?? "—"} · Read directly from Robinhood Chain
          </p>
          <div className="balance-actions">
            <a href="/dashboard/send" className="button accent">
              <ArrowUpRight size={17} />
              Send
            </a>
            <button type="button" onClick={() => setModal("receive")} className="button outline">
              <ArrowDownLeft size={17} />
              Receive
            </button>
          </div>
          <div className="balance-card-bottom">
            {me ? <AddressText value={me.address} /> : <span>Wallet address unavailable</span>}
            <span className="non-custodial">
              <Lock size={12} />
              Non-custodial
            </span>
          </div>
        </section>

        <section className="quick-send card">
          <div className="panel-heading">
            <h2>Quick transfer</h2>
            <span className="round-icon">
              <Send size={17} />
            </span>
          </div>
          <p>Send to a phone number linked to a wallet.</p>
          <form onSubmit={continueToSend}>
            <label className="sr-only" htmlFor="quick-send-phone">
              Recipient phone number
            </label>
            <PhoneInput
              id="quick-send-phone"
              value={recipient}
              onChange={(value) => setRecipient(value ?? "")}
            />
            <button type="submit" className="button light-button" disabled={!validRecipient}>
              Continue <ArrowUpRight size={16} />
            </button>
          </form>
          <small>Your wallet approves every transfer.</small>
        </section>
      </div>
      {balanceError && (
        <div className="notice" role="alert">
          <span>{balanceError.message}</span>
          <button type="button" disabled={refreshing} onClick={() => void refreshPortfolio()}>
            Refresh
          </button>
        </div>
      )}
    </>
  );
}
