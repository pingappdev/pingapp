import { useState } from "react";
import { ArrowUpRight, ExternalLink, History, Search } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTransfers } from "../../api/hooks";
import { useAuth } from "../../auth/useAuth";
import { explorerAddress } from "../../config";
import { useRouter, useSearchParams } from "../../routing";
import ActivityTable from "../components/ActivityTable";
import Empty from "../components/Empty";
import { activityDirection } from "./activityDirection";

export default function Activity() {
  const { me } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const direction = activityDirection(params.get("direction"));
  const transfers = useTransfers(direction);
  const [query, setQuery] = useState("");
  const rows = transfers.data?.pages.flatMap((page) => page.items) ?? [];
  const search = query.trim().toLowerCase();
  const shown = rows.filter((row) =>
    [
      row.txHash,
      row.from.address,
      row.to.address,
      row.from.displayName,
      row.to.displayName,
      row.contactName,
      row.token.symbol,
      row.amount,
    ].some((value) => value?.toLowerCase().includes(search)),
  );

  return (
    <>
      <div className="toolbar activity-toolbar">
        <label className="input-icon">
          <Search size={17} />
          <input
            placeholder="Search hash, address, name, or token"
            aria-label="Search loaded transfers"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Select
          value={direction}
          onValueChange={(value) => {
            const next = new URLSearchParams(params);
            next.set("direction", activityDirection(value));
            router.push(`/dashboard/activity?${next.toString()}`, { scroll: false });
          }}
        >
          <SelectTrigger aria-label="Transfer direction" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="received">Received</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <section className="card">
        {transfers.isError && (
          <div className="notice" role="alert">
            <p>We couldn&apos;t load your transfers. Please try again.</p>
            <button
              className="button outline"
              type="button"
              disabled={transfers.isFetching}
              onClick={() => void transfers.refetch()}
            >
              Try again
            </button>
          </div>
        )}
        {transfers.isPending ? (
          <p className="field-help" role="status">
            Loading transfers…
          </p>
        ) : shown.length ? (
          <ActivityTable rows={shown} />
        ) : (
          !transfers.isError && (
            <Empty
              icon={<History />}
              title={rows.length ? "No matching transfers" : "No transfers yet"}
              text={
                rows.length
                  ? "No transfers match your search."
                  : "Your transfers will appear here, with a link to their on-chain record."
              }
              action={
                !rows.length ? (
                  <a className="button outline" href="/dashboard/send">
                    Send crypto <ArrowUpRight size={16} />
                  </a>
                ) : undefined
              }
            />
          )
        )}
        {transfers.hasNextPage && (
          <button
            className="button outline"
            type="button"
            disabled={transfers.isFetching}
            onClick={() => void transfers.fetchNextPage()}
          >
            {transfers.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
      <p className="panel-footnote">
        This list covers transfers made through PingApp, and transfers you received from other
        PingApp users. For your full wallet history,{" "}
        {me ? (
          <a href={explorerAddress(me.address)} target="_blank" rel="noreferrer">
            open your address in the explorer <ExternalLink size={13} />
          </a>
        ) : (
          "open your address in the explorer"
        )}
        .
      </p>
    </>
  );
}
