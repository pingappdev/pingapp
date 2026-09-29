import { useCallback, useEffect, useRef, useState } from "react";
import { readBalances, workspaceApi as api } from "../lib/workspace";
import { useAuth } from "../auth/useAuth";
import { isAddress } from "./format";
import type { Balance, Contact, DashboardBaseState, Workspace } from "./state";

const DEFAULT_NETWORK = "robinhood";

export function useDashboardState(view: string): DashboardBaseState {
  const { me } = useAuth();
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
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState(false);
  const [approved, setApproved] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState(true);
  const [activityFilter, setActivityFilter] = useState("all");
  const profile = {
    ...(data?.profile ?? {
      display_name: "",
      wallet: "",
      network: DEFAULT_NETWORK,
      confirm_transfers: 1,
    }),
    wallet: me?.address ?? "",
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
