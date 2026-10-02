import { ArrowDownLeft, ArrowUpRight, ExternalLink } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Transfer } from "../../api/types";
import { explorerTx } from "../../config";
import { trimAddress } from "../format";
import Amount from "./Amount";
import StatusPill from "./StatusPill";
import TokenIcon from "./TokenIcon";

function transferLabel(row: Transfer): string {
  if (row.direction === "sent") {
    return `Sent to ${row.to.displayName ?? row.contactName ?? row.to.phoneMasked ?? trimAddress(row.to.address)}`;
  }
  return `Received from ${row.from.displayName ?? trimAddress(row.from.address)}`;
}

function shortHash(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

export default function ActivityTable({ rows }: { rows: Transfer[] }) {
  return (
    <Table className="activity-table">
      <TableHeader>
        <TableRow>
          <TableHead>Transfer</TableHead>
          <TableHead>Asset</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Explorer</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((transfer) => {
          const sent = transfer.direction === "sent";
          const hash = transfer.txHash;
          const label = transferLabel(transfer);
          const href = transfer.explorerUrl || explorerTx(hash);
          const amount = transfer.amount;
          const { symbol, logoUrl } = transfer.token;
          const date = transfer.createdAt;
          const DirectionIcon = sent ? ArrowUpRight : ArrowDownLeft;

          return (
            <TableRow key={transfer.id}>
              <TableCell className="transfer-party">
                <div className="asset-name activity-transfer">
                  <span className="round-icon">
                    <DirectionIcon size={17} />
                  </span>
                  <div>
                    <strong>{label}</strong>
                    <small>{shortHash(hash)}</small>
                  </div>
                </div>
              </TableCell>
              <TableCell className="transfer-asset">
                <div className="asset-name activity-asset">
                  <TokenIcon symbol={symbol} logoUrl={logoUrl} />
                  <span>
                    <strong>
                      <Amount value={amount} symbol={symbol} />
                    </strong>
                    <small>{transfer.token.name}</small>
                  </span>
                </div>
              </TableCell>
              <TableCell className="transfer-date">
                <time dateTime={date}>{new Date(date).toLocaleDateString()}</time>
              </TableCell>
              <TableCell className="transfer-status">
                <StatusPill status={transfer.status} />
              </TableCell>
              <TableCell className="transfer-explorer">
                <a className="explorer-link" target="_blank" rel="noreferrer" href={href}>
                  View <ExternalLink size={13} />
                </a>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
