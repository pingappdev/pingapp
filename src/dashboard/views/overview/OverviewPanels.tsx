import { ArrowUpRight, History, Plus, RefreshCw, ShieldCheck, Users } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import ActivityTable from "../../components/ActivityTable";
import NetworkLabel from "../../components/NetworkLabel";
import { useDashboard } from "../../state";

export default function OverviewPanels() {
  const { balance, balanceLoading, network, refreshBalance, contacts, setModal, history } =
    useDashboard();

  return (
    <>
      <div className="dashboard-two-column">
        <section className="card holdings">
          <div className="panel-heading">
            <h2>Asset balances</h2>
            <button className="icon-button" aria-label="Refresh balances" onClick={refreshBalance}>
              <RefreshCw size={16} className={balanceLoading ? "spin" : ""} />
            </button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead>Network</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[{ symbol: "ETH", name: "Ethereum", value: balance?.eth }].map((asset) => (
                <TableRow key={asset.symbol}>
                  <TableCell>
                    <div className="asset-name">
                      <span className={"token-icon " + asset.symbol.toLowerCase()}>
                        <img
                          src={
                            "/assets/brands/" +
                            (asset.symbol === "ETH" ? "ethereum" : "usdc") +
                            ".svg"
                          }
                          alt=""
                          width={36}
                          height={36}
                        />
                      </span>
                      <div>
                        <strong>{asset.name}</strong>
                        <small>{asset.symbol}</small>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <NetworkLabel _network={network} />
                  </TableCell>
                  <TableCell className="text-right">
                    {asset.value
                      ? Number(asset.value).toLocaleString(undefined, {
                          maximumFractionDigits: asset.symbol === "ETH" ? 6 : 2,
                        })
                      : "—"}{" "}
                    <small>{asset.symbol}</small>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="panel-footnote">
            {balance
              ? "Updated " + new Date(balance.updated).toLocaleTimeString()
              : "Balances appear after you connect or add a wallet."}
          </p>
        </section>
        <section className="card contacts-preview">
          <div className="panel-heading">
            <h2>Saved recipients</h2>
            <a href="/dashboard/contacts" aria-label="View all contacts">
              <ArrowUpRight size={18} />
            </a>
          </div>
          {contacts.length ? (
            contacts.slice(0, 3).map((contact) => (
              <a
                className="contact-mini"
                key={contact.id}
                href={"/dashboard/send?to=" + encodeURIComponent(contact.phone)}
              >
                <span className="contact-initial">{contact.name[0]}</span>
                <span>
                  <strong>{contact.name}</strong>
                  <small>{contact.phone}</small>
                </span>
                <ArrowUpRight size={17} />
              </a>
            ))
          ) : (
            <div className="empty-compact">
              <Users size={26} />
              <h3>Your address book</h3>
              <p>Save recipients for quicker, more consistent transfers.</p>
              <button className="text-link" onClick={() => setModal("contact")}>
                Add a contact <Plus size={15} />
              </button>
            </div>
          )}
        </section>
      </div>
      <section className="card recent-activity">
        <div className="panel-heading">
          <h2>Recent activity</h2>
          <a href="/dashboard/activity" className="text-link">
            View all <ArrowUpRight size={15} />
          </a>
        </div>
        {history.length ? (
          <ActivityTable rows={history.slice(0, 4)} />
        ) : (
          <div className="empty-row">
            <span className="round-icon">
              <History size={22} />
            </span>
            <div>
              <strong>No transfers yet</strong>
              <p>Transfers submitted through PingApp will appear here.</p>
            </div>
            <a href="/dashboard/send">
              Start a transfer <ArrowUpRight size={17} />
            </a>
          </div>
        )}
      </section>
      <div className="dashboard-bottom-line">
        <ShieldCheck size={16} />
        <span>PingApp connects. Your wallet stays in control.</span>
        <a href="/what-we-do/security">Learn more ↗</a>
      </div>
    </>
  );
}
