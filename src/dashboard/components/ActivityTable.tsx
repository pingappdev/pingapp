import { ArrowUpRight, ExternalLink } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { explorerTx } from "../../config";
import type { Activity } from "../state";
import NetworkLabel from "./NetworkLabel";
import { trimAddress } from "../format";

export default function ActivityTable({ rows }: { rows: Activity[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Transfer</TableHead>
          <TableHead>Network</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((transfer) => (
          <TableRow key={transfer.id}>
            <TableCell>
              <div className="asset-name">
                <span className="round-icon">
                  <ArrowUpRight size={17} />
                </span>
                <div>
                  <strong>Sent to {trimAddress(transfer.address)}</strong>
                  <small>{trimAddress(transfer.hash)}</small>
                </div>
              </div>
            </TableCell>
            <TableCell>
              <NetworkLabel _network={transfer.network} />
            </TableCell>
            <TableCell>{transfer.amount} ETH</TableCell>
            <TableCell>{new Date(transfer.created).toLocaleDateString()}</TableCell>
            <TableCell>
              <a
                className="explorer-link"
                target="_blank"
                rel="noreferrer"
                href={explorerTx(transfer.hash)}
              >
                Check on-chain <ExternalLink size={13} />
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
