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
import type { Activity } from "../state";
import Amount from "./Amount";
import StatusPill from "./StatusPill";
import TokenIcon from "./TokenIcon";

type ActivityRow = Transfer | Activity;

function isTransfer(row: ActivityRow): row is Transfer {
  return "txHash" in row;
}

function transferLabel(row: Transfer): string {
  if (row.direction === "sent") {
    return `Sent to ${row.to.displayName ?? row.contactName ?? row.to.phoneMasked ?? trimAddress(row.to.address)}`;
  }
  return `Received from ${row.from.displayName ?? trimAddress(row.from.address)}`;
}

function shortHash(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

export default function ActivityTable({ rows }: { rows: ActivityRow[] }) {
  return (
    <Table>
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
        {rows.map((row) => {
          // Keep the old workspace shape working while these views switch to API rows.
          const activity = isTransfer(row) ? null : row;
          const transfer = isTransfer(row) ? row : null;
          const sent = !transfer || transfer.direction === "sent";
          const hash = transfer?.txHash ?? activity?.hash ?? "";
          const label = transfer
            ? transferLabel(transfer)
            : `Sent to ${trimAddress(activity?.address ?? "")}`;
          const href = transfer?.explorerUrl ?? explorerTx(hash);
          const amount = transfer?.amount ?? activity?.amount ?? "0";
          const symbol = transfer?.token.symbol ?? "ETH";
          const logoUrl = transfer?.token.logoUrl ?? null;
          const date =
            transfer?.createdAt ?? (activity ? new Date(activity.created).toISOString() : "");
          const DirectionIcon = sent ? ArrowUpRight : ArrowDownLeft;

          return (
            <TableRow key={row.id}>
              <TableCell>
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
              <TableCell>
                <div className="asset-name activity-asset">
                  <TokenIcon symbol={symbol} logoUrl={logoUrl} />
                  <span>
                    <strong>
                      <Amount value={amount} symbol={symbol} />
                    </strong>
                    <small>{transfer?.token.name ?? "Ethereum"}</small>
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <time dateTime={date}>{new Date(date).toLocaleDateString()}</time>
              </TableCell>
              <TableCell>
                {transfer ? (
                  <StatusPill status={transfer.status} />
                ) : (
                  <span className="pill">Recorded</span>
                )}
              </TableCell>
              <TableCell>
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
