import { ArrowUpRight, Check, ExternalLink, Link2, ShieldCheck, Wallet } from "lucide-react";
import { chain, explorerTx } from "../../config";
import { useDashboard } from "../state";
import { trimAddress } from "../format";
import Connection from "../components/Connection";
import NetworkLabel from "../components/NetworkLabel";

export default function Send() {
  const {
    recipient,
    setRecipient,
    setReview,
    currentContact,
    destination,
    submitSend,
    amount,
    setAmount,
    balance,
    busy,
    txHash,
    copy,
    wallet,
    connect,
  } = useDashboard();

  return (
    <div className="send-grid">
      <section className="card send-form">
        <h2>Transfer details</h2>
        <p>Enter an EVM address or a phone number saved in your contacts.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitSend();
          }}
        >
          <label>
            Recipient
            <input
              required
              value={recipient}
              onChange={(event) => {
                setRecipient(event.target.value);
                setReview(false);
              }}
              placeholder="+60 12 345 6789 or 0x…"
            />
          </label>
          {currentContact && (
            <div className="recipient-match">
              <Check size={18} />
              <span>
                {currentContact.name}
                <small>Saved contact · Not phone verified</small>
              </span>
            </div>
          )}
          {recipient && !destination && (
            <p className="field-help">
              {recipient.startsWith("+")
                ? "This number is not in your contact book. Public phone lookup is not connected. Ask the recipient for their wallet address."
                : "Enter a complete 0x wallet address or a saved phone number."}
            </p>
          )}
          <div className="send-network-label">
            <span>Network</span>
            <NetworkLabel />
            <span className={`chain-environment${chain.testnet ? " testnet" : ""}`}>
              {chain.testnet ? "Testnet" : "Mainnet"}
            </span>
          </div>
          <label>
            Amount
            <div className="amount-input">
              <input
                required
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                aria-label="Amount in ETH"
              />
              <span>
                <img src="/assets/brands/ethereum.svg" alt="" width={24} height={24} />
                ETH
              </span>
            </div>
          </label>
          <p className="field-help">
            {balance ? Number(balance.eth).toFixed(6) + " ETH available. " : ""}Network fees are
            shown in your wallet.
          </p>
          <button className="button accent" type="submit" disabled={busy}>
            Review transfer <ArrowUpRight size={17} />
          </button>
        </form>
        {txHash && (
          <div className="transaction-result">
            <Check />
            <h3>Transfer submitted</h3>
            <p>Confirm its network status in the explorer.</p>
            <a href={explorerTx(txHash)} target="_blank" rel="noreferrer">
              View transaction <ExternalLink size={15} />
            </a>
            <button onClick={() => copy(txHash)}>Copy transaction hash</button>
          </div>
        )}
      </section>
      <aside>
        <section className="card send-wallet">
          <Wallet />
          <h3>Your sending wallet</h3>
          <p>{trimAddress(wallet)}</p>
          <Connection />
          <button className="button outline" onClick={connect} disabled={busy}>
            {wallet ? "Reconnect wallet" : "Connect wallet"}
            <Link2 size={16} />
          </button>
        </section>
        <section className="send-note">
          <ShieldCheck />
          <h3>Review before sending</h3>
          <p>
            Confirm the full destination address with your recipient. A familiar phone number is a
            starting point, not proof of identity.
          </p>
          <a href="/insights/safer-connections" className="text-link">
            Read the guide <ArrowUpRight size={15} />
          </a>
        </section>
      </aside>
    </div>
  );
}
