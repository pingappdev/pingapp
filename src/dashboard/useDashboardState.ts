import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { readBalances, workspaceApi as api } from "../lib/workspace";
import { isAddress } from "./format";
import type { Balance, Contact, DashboardBaseState, Profile, Workspace } from "./state";

const DEFAULT_NETWORK = "robinhood";

type Provider = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (e: string, fn: (a: unknown) => void) => void;
  removeListener?: (e: string, fn: (a: unknown) => void) => void;
};

const provider = () =>
  typeof window === "undefined"
    ? undefined
    : (window as unknown as { ethereum?: Provider }).ethereum;

export function useDashboardState(view: string): DashboardBaseState {
  const balanceVersion = useRef(0);
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState("");
  const [query, setQuery] = useState("");
  const [remove, setRemove] = useState<Contact | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [connected, setConnected] = useState("");
  const [readAddress, setReadAddress] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState(false);
  const [approved, setApproved] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState(true);
  const [activityFilter, setActivityFilter] = useState("all");
  const profile = data?.profile ?? {
    display_name: "",
    wallet: "",
    network: DEFAULT_NETWORK,
    confirm_transfers: 1,
  };
  const network = DEFAULT_NETWORK;
  const wallet = profile.wallet;
  const contacts = data?.contacts ?? [];
  const history = data?.activity ?? [];
  const currentContact = contacts.find(
    (contact) =>
      contact.phone === recipient || contact.address.toLowerCase() === recipient.toLowerCase(),
  );
  const destination = isAddress(recipient) ? recipient : (currentContact?.address ?? "");

  const load = useCallback(async () => {
    setError("");
    try {
      const workspace = await api();
      setData(workspace);
      setName(workspace.profile.display_name);
      setConfirm(!!workspace.profile.confirm_transfers);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setModal("");
    setReview(false);
    setRemove(null);
    setQuery("");
  }, [view]);

  const refreshBalance = useCallback(async () => {
    const version = ++balanceVersion.current;
    setBalance(null);
    setBalanceError("");
    if (!wallet) {
      setBalanceLoading(false);
      return;
    }
    setBalanceLoading(true);
    try {
      const currentBalance = await readBalances(wallet, network);
      if (version === balanceVersion.current) setBalance(currentBalance);
    } catch (balanceLoadError) {
      if (version === balanceVersion.current) setBalanceError((balanceLoadError as Error).message);
    } finally {
      if (version === balanceVersion.current) setBalanceLoading(false);
    }
  }, [wallet, network]);

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  useEffect(() => {
    const walletProvider = provider();
    if (!walletProvider) return;
    const changed = (accounts: unknown) => {
      const first = Array.isArray(accounts) ? accounts[0] : "";
      setConnected(typeof first === "string" ? first : "");
      setReview(false);
    };
    const chainChanged = () => {
      setReview(false);
      setConnected("");
      toast("Wallet network changed. Reconnect before sending.");
    };
    walletProvider
      .request({ method: "eth_accounts" })
      .then(changed)
      .catch(() => {});
    walletProvider.on?.("accountsChanged", changed);
    walletProvider.on?.("chainChanged", chainChanged);
    return () => {
      walletProvider.removeListener?.("accountsChanged", changed);
      walletProvider.removeListener?.("chainChanged", chainChanged);
    };
  }, []);

  return {
    view,
    data,
    error,
    loading,
    busy,
    modal,
    query,
    remove,
    balance,
    balanceError,
    balanceLoading,
    connected,
    readAddress,
    recipient,
    amount,
    review,
    approved,
    txHash,
    name,
    confirm,
    activityFilter,
    profile,
    network,
    wallet,
    contacts,
    history,
    currentContact,
    destination,
    setData,
    setError,
    setLoading,
    setBusy,
    setModal,
    setQuery,
    setRemove,
    setBalance,
    setBalanceError,
    setBalanceLoading,
    setConnected,
    setReadAddress,
    setRecipient,
    setAmount,
    setReview,
    setApproved,
    setTxHash,
    setName,
    setConfirm,
    setActivityFilter,
    load,
    refreshBalance,
  };
}
