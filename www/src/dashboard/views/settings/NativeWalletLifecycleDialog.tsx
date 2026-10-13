import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, endpoints } from "@/api/client";
import { useBalances } from "@/api/hooks";
import { useAuth } from "@/auth/useAuth";
import { keyManager, WalletError } from "@/wallet/native/keyManager";
import { authenticateWallet } from "@/wallet/native/lockPolicy";
import { walletCleanup } from "@/wallet/native/walletCleanup";
import { PlatformError } from "@/platform";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function NativeWalletLifecycleDialog({
  action,
  onExport,
}: {
  action: "delete" | "remove";
  onExport?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const operation = useRef(false);
  const generation = useRef(0);
  const balances = useBalances({ enabled: open, refresh: true });
  const refetchBalances = balances.refetch;
  const client = useQueryClient();
  const { me, withReauth } = useAuth();
  const word = action === "delete" ? "DELETE" : "REMOVE";
  const label = action === "delete" ? "Delete account" : "Remove wallet from this device";
  const copy =
    action === "delete"
      ? "Deletes your PingApp account (phone link, contacts, history). Funds stay on-chain in this wallet."
      : "Removes the key from this phone only. Your account stays and you can import the key again.";
  const items = balances.data?.items ?? [];
  const valid =
    checked &&
    balances.isSuccess &&
    !balances.isFetching &&
    balances.data?.address.toLowerCase() === me?.address.toLowerCase() &&
    items.length > 0 &&
    items.every((item) => /^\d+$/.test(item.balanceRaw));
  const funded = items.filter(
    (item) => /^\d+$/.test(item.balanceRaw) && BigInt(item.balanceRaw) > 0n,
  );
  const allowed = valid && (!funded.length || acknowledged) && confirmation === word;
  const readiness = useRef(false);
  readiness.current = allowed;
  const unmount = useCallback(() => {
    mounted.current = false;
    generation.current++;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return unmount;
  }, [unmount]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setChecked(false);
    void refetchBalances().then((result) => {
      if (current) setChecked(result.isSuccess);
    });
    return () => {
      current = false;
    };
  }, [open, refetchBalances]);

  function changeOpen(next: boolean) {
    if (operation.current) return;
    generation.current++;
    setOpen(next);
    setConfirmation("");
    setAcknowledged(false);
    setError("");
    setChecked(false);
  }
  async function proceed() {
    if (!allowed || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    const expected = generation.current;
    const walletEpoch = keyManager.getEpoch();
    const active = () =>
      mounted.current &&
      generation.current === expected &&
      keyManager.getState() === "unlocked" &&
      keyManager.getEpoch() === walletEpoch;
    try {
      await authenticateWallet(action === "delete" ? "Delete account" : "Remove wallet", active);
      if (!active()) return;
      if (!readiness.current)
        throw new WalletError(
          "BalancesChanged",
          "Wallet balances changed. Review them before continuing.",
        );
      if (action === "delete") {
        // The shared mutation publishes signed-out before cleanup; use the endpoint
        // here so API failure keeps the key and the retry UI intact.
        await walletCleanup.beforeDelete();
        try {
          await withReauth(async () => {
            if (!active()) throw new WalletError("WalletLocked", "Unlock your wallet to continue.");
            if (!readiness.current)
              throw new WalletError(
                "BalancesChanged",
                "Wallet balances changed. Review them before continuing.",
              );
            await endpoints.me.delete();
          });
        } catch (reason) {
          await walletCleanup.deleteFailed(
            reason instanceof ApiError &&
              reason.status >= 400 &&
              reason.status < 500 &&
              reason.status !== 408,
          );
          throw reason;
        }
      }
      // A successful backend deletion must finish cleanup even if Settings unmounts.
      await walletCleanup.start(action, client);
    } catch (reason) {
      if (mounted.current && generation.current === expected)
        setError(
          reason instanceof ApiError ||
            reason instanceof WalletError ||
            reason instanceof PlatformError
            ? reason.message
            : "Could not complete this action. Try again.",
        );
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      {action === "remove" && <p>{copy}</p>}
      <button className="button outline" onClick={() => changeOpen(true)}>
        {label}
      </button>
      <AlertDialog open={open} onOpenChange={changeOpen}>
        <AlertDialogContent
          className="workspace-alert"
          style={{ maxHeight: "85dvh", overflowY: "auto" }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {action === "delete" ? "Delete your PingApp account?" : "Remove this wallet?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {copy} You will need your exported key to access this wallet again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!valid && (
            <div role="status">
              <p>
                {balances.isFetching
                  ? "Checking wallet balances…"
                  : "Wallet balances are unavailable. Check them before continuing."}
              </p>
              {!balances.isFetching && (
                <button
                  className="button outline"
                  onClick={() => {
                    setChecked(false);
                    void balances.refetch().then((result) => setChecked(result.isSuccess));
                  }}
                >
                  Retry balances
                </button>
              )}
            </div>
          )}
          {funded.length > 0 && (
            <div>
              <strong>This wallet still holds funds</strong>
              <ul>
                {funded.map((item) => (
                  <li key={item.token.address}>
                    {item.balance} {item.token.symbol}
                  </li>
                ))}
              </ul>
              <p>
                Funds stay on-chain. Removing this key without a backup can permanently lose access.
              </p>
              <label style={{ display: "flex", alignItems: "start", gap: 10 }}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                I exported my key or accept losing these funds
              </label>
            </div>
          )}
          <button
            className="button outline"
            disabled={busy}
            onClick={() => {
              changeOpen(false);
              if (onExport) onExport();
              else window.dispatchEvent(new Event("pingapp:export-wallet"));
              document.getElementById("wallet")?.scrollIntoView({ block: "start" });
            }}
          >
            Export private key first
          </button>
          <label>
            Type {word} to continue
            <input
              className="auth-input"
              autoComplete="off"
              value={confirmation}
              disabled={busy}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {action === "delete" ? "Keep account" : "Keep wallet"}
            </AlertDialogCancel>
            <button
              className="button accent"
              disabled={!allowed || busy}
              onClick={() => void proceed()}
            >
              {busy ? "Confirming…" : label}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
