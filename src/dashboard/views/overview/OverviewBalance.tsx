import { ArrowDownLeft, ArrowUpRight, Copy, Lock, Phone, Send, Wallet } from "lucide-react";
import { chain } from "../../../config";
import { trimAddress } from "../../format";
import { useDashboard } from "../../state";
import NetworkLabel from "../../components/NetworkLabel";

export default function OverviewBalance() {
  const {
    balance,
    balanceLoading,
    wallet,
    setModal,
    connect,
    busy,
    copy,
    recipient,
    setRecipient,
  } = useDashboard();

  return (
    <div className="overview-grid">
      <section className="balance-card">
        <div className="card-top">
          <span>AVAILABLE BALANCE</span>
          <div className="balance-network-label">
            <NetworkLabel />
            <span className={`chain-environment${chain.testnet ? " testnet" : ""}`}>
              {chain.testnet ? "Testnet" : "Mainnet"}
            </span>
          </div>
        </div>
        <div className="balance-number">
          {balanceLoading
            ? "···"
            : balance
              ? Number(balance.eth).toLocaleString(undefined, { maximumFractionDigits: 6 })
              : "—"}
          <span>ETH</span>
        </div>
        <p className="balance-caption">
          {wallet
            ? "Read directly from " + chain.name
            : "Connect your wallet to see your holdings."}
        </p>
        <div className="balance-actions">
          {wallet ? (
            <>
              <a href="/dashboard/send" className="button accent">
                <ArrowUpRight size={17} />
                Send
              </a>
              <button onClick={() => setModal("receive")} className="button outline">
                <ArrowDownLeft size={17} />
                Receive
              </button>
            </>
          ) : (
            <button onClick={connect} disabled={busy} className="button accent">
              <Wallet size={18} />
              Connect wallet
            </button>
          )}
        </div>
        <div className="balance-card-bottom">
          <span>
            <Wallet size={14} />
            {trimAddress(wallet)}
          </span>
          {wallet && (
            <button aria-label="Copy wallet address" onClick={() => copy(wallet)}>
              <Copy size={14} />
            </button>
          )}
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
        <p>Send to an address, or choose someone from your contacts.</p>
        <label className="input-icon">
          <Phone size={17} />
          <input
            aria-label="Recipient phone or wallet"
            placeholder="Phone number or 0x address"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
          />
        </label>
        <a
          className="button light-button"
          href={"/dashboard/send" + (recipient ? "?to=" + encodeURIComponent(recipient) : "")}
        >
          Continue <ArrowUpRight size={16} />
        </a>
        <small>Your wallet approves every transfer.</small>
      </section>
    </div>
  );
}
