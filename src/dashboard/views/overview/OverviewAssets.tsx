import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useBalances } from "../../../api/hooks";
import type { Asset } from "../../../api/types";
import Amount from "../../components/Amount";
import TokenIcon from "../../components/TokenIcon";
import Usd from "../../components/Usd";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Balances are unavailable.";
}

function displayTokenName(asset: Asset): string {
  return asset.token.kind === "stock"
    ? asset.token.name.replace(/\s*•\s*Robinhood Token$/, "")
    : asset.token.name;
}

function updatedLabel(value: string | undefined): string {
  if (!value) return "Balances haven't loaded yet.";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Balance update time unavailable."
    : `Updated ${date.toLocaleTimeString()}`;
}

export default function OverviewAssets() {
  const balances = useBalances();
  const items = balances.data?.items ?? [];

  return (
    <section className="card holdings">
      <div className="panel-heading">
        <h2>Asset balances</h2>
      </div>
      <Table className="holdings-table">
        <TableHeader>
          <TableRow>
            <TableHead>Asset</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">USD value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {balances.isPending && !balances.data ? (
            [0, 1, 2].map((row) => (
              <TableRow key={row} aria-hidden="true">
                <TableCell className="holding-asset">
                  <div className="asset-name">
                    <Skeleton className="h-9 w-9 rounded-full" />
                    <div>
                      <Skeleton className="mb-2 h-4 w-24" />
                      <Skeleton className="h-3 w-12" />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="holding-amount">
                  <Skeleton className="ml-auto h-4 w-20" />
                </TableCell>
                <TableCell className="holding-value">
                  <Skeleton className="ml-auto h-4 w-16" />
                </TableCell>
              </TableRow>
            ))
          ) : balances.error && !balances.data ? (
            <TableRow>
              <TableCell colSpan={3}>
                <span role="alert">{errorText(balances.error)}</span>
              </TableCell>
            </TableRow>
          ) : items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3}>No token balances were returned.</TableCell>
            </TableRow>
          ) : (
            items.map((asset) => (
              <TableRow key={asset.token.address}>
                <TableCell className="holding-asset">
                  <div className="asset-name">
                    <TokenIcon symbol={asset.token.symbol} logoUrl={asset.token.logoUrl} />
                    <div>
                      <strong>{displayTokenName(asset)}</strong>
                      <small>{asset.token.symbol}</small>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="holding-amount text-right">
                  <Amount value={asset.balance} symbol={asset.token.symbol} />
                </TableCell>
                <TableCell className="holding-value text-right">
                  <Usd value={asset.valueUsd} />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <p className="panel-footnote">{updatedLabel(balances.data?.updatedAt)}</p>
    </section>
  );
}
