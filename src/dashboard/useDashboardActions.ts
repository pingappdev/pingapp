import { toast } from "sonner";
import { chain } from "../config";
import { workspaceApi as api } from "../lib/workspace";
import { isAddress } from "./format";
import type { DashboardActions, DashboardBaseState, Profile } from "./state";

type Provider = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
};

const provider = () =>
  typeof window === "undefined"
    ? undefined
    : (window as unknown as { ethereum?: Provider }).ethereum;

export function useDashboardActions(state: DashboardBaseState): DashboardActions {
  const {
    data,
    profile,
    network,
    wallet,
    connected,
    destination,
    amount,
    approved,
    query,
    activityFilter,
    history,
    setData,
    setModal,
    setBusy,
    setConnected,
    setReview,
    setApproved,
    setTxHash,
    setAmount,
    setReadAddress,
    readAddress,
    load,
    refreshBalance,
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
    const walletProvider = provider();
    if (!walletProvider) {
      setModal("wallet");
      return;
    }
    setBusy(true);
    try {
      const accounts = (await walletProvider.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (!accounts[0] || !isAddress(accounts[0]))
        throw new Error("No wallet address was provided.");
      await saveProfile({ wallet: accounts[0] });
      setConnected(accounts[0]);
      setModal("");
      toast.success("Wallet connected");
    } catch (error) {
      toast.error((error as Error).message ?? "Wallet connection was cancelled.");
    } finally {
      setBusy(false);
    }
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
    if (!wallet || connected.toLowerCase() !== wallet.toLowerCase()) {
      toast.error("Connect the sending wallet before continuing.");
      setModal("wallet");
      return;
    }
    setReview(true);
    setApproved(false);
  }

  async function sendTransaction() {
    const walletProvider = provider();
    if (!walletProvider || !approved) return;
    setBusy(true);
    try {
      const accounts = (await walletProvider.request({ method: "eth_accounts" })) as string[];
      if (accounts[0]?.toLowerCase() !== wallet.toLowerCase())
        throw new Error("Your wallet account changed. Reconnect and review this transfer again.");
      if (
        (await walletProvider.request({ method: "eth_chainId" })) !==
        "0x" + chain.id.toString(16)
      )
        throw new Error("Select " + chain.name + " in your wallet before sending.");
      const finalAccounts = (await walletProvider.request({ method: "eth_accounts" })) as string[];
      if (finalAccounts[0]?.toLowerCase() !== wallet.toLowerCase())
        throw new Error("Your wallet account changed. Reconnect and review this transfer again.");
      const [whole, fraction = ""] = amount.split(".");
      const value = BigInt(whole) * BigInt(10) ** BigInt(18) + BigInt(fraction.padEnd(18, "0"));
      const hash = (await walletProvider.request({
        method: "eth_sendTransaction",
        params: [{ from: wallet, to: destination, value: "0x" + value.toString(16) }],
      })) as string;
      if (!/^0x[a-fA-F0-9]{64}$/.test(hash))
        throw new Error(
          "The wallet did not return a transaction hash. Check its activity before retrying.",
        );
      setTxHash(hash);
      setReview(false);
      try {
        await api({ action: "activity", hash, network, address: destination, amount });
        await load();
        toast.success("Transfer submitted. View confirmation in the explorer.");
      } catch {
        toast.error(
          "Transfer submitted, but activity could not be saved. Keep the transaction hash below.",
        );
      }
      setAmount("");
      refreshBalance();
    } catch (error) {
      toast.error((error as Error).message ?? "The transfer request was not completed.");
    } finally {
      setBusy(false);
    }
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
