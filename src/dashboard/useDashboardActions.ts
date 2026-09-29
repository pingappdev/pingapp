import { toast } from "sonner";
import { workspaceApi as api } from "../lib/workspace";
import { isAddress } from "./format";
import { useAccount } from "wagmi";
import { openConnect } from "../wallet/appkit";
import type { DashboardActions, DashboardBaseState, Profile } from "./state";

export function useDashboardActions(state: DashboardBaseState): DashboardActions {
  const account = useAccount();
  const {
    data,
    profile,
    network,
    wallet,
    destination,
    amount,
    query,
    activityFilter,
    history,
    setData,
    setReview,
    setApproved,
  } = state;

  async function saveProfile(changes: Partial<Profile>) {
    const next = { ...profile, network, ...changes };
    await api({
      action: "profile",
      displayName: next.display_name,
      wallet: next.wallet,
      network: next.network,
      confirmTransfers: !!next.confirm_transfers,
    });
    setData((current) => (current ? { ...current, profile: next } : current));
  }

  async function connect() {
    await openConnect();
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy was unavailable. You can select and copy the address.");
    }
  }

  async function submitSend() {
    if (!destination || !/^\d+(\.\d{1,18})?$/.test(amount) || Number(amount) <= 0) {
      toast.error("Enter a recipient wallet and an amount greater than zero.");
      return;
    }
    if (!wallet || account.address?.toLowerCase() !== wallet.toLowerCase()) {
      toast.error("Connect the sending wallet before continuing.");
      await openConnect();
      return;
    }
    setReview(true);
    setApproved(false);
  }

  async function sendTransaction() {
    // FE-09 replaces this screen with a token-aware send and transfer recording flow.
    toast.error("Transfers are being connected to your signed-in wallet.");
  }

  const filtered = state.contacts.filter((contact) =>
    [contact.name, contact.phone, contact.address].some((value) =>
      value.toLowerCase().includes(query.toLowerCase()),
    ),
  );
  const shownHistory = history.filter(
    (transfer) =>
      (activityFilter === "all" || transfer.network === activityFilter) &&
      [transfer.hash, transfer.address, transfer.amount].some((value) =>
        value.toLowerCase().includes(query.toLowerCase()),
      ),
  );

  function exportActivity() {
    const rows = [
      ["Date", "Network", "Destination", "Amount ETH", "Transaction Hash"],
      ...shownHistory.map((transfer) => [
        new Date(transfer.created).toISOString(),
        transfer.network,
        transfer.address,
        transfer.amount,
        transfer.hash,
      ]),
    ];
    const blob = new Blob(
      [
        rows
          .map((row) => row.map((value) => '"' + value.replaceAll('"', '""') + '"').join(","))
          .join("\n"),
      ],
      { type: "text/csv" },
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "pingapp-activity.csv";
    link.click();
    URL.revokeObjectURL(link.href);
    toast.success("Activity exported");
  }

  return {
    saveProfile,
    connect,
    copy,
    submitSend,
    sendTransaction,
    filtered,
    shownHistory,
    exportActivity,
  };
}
