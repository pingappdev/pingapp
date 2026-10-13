import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { useSession } from "@/api/hooks";
import { safeReturnTo } from "@/auth/return-to";
import { removeNativeWallet, resumeNativeSession } from "@/auth/nativeSession";
import { platform, type Unsubscribe } from "@/platform";
import { useBackHandler } from "@/platform/backHandlerStack";
import { useRouter } from "@/routing";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { keyManager, WalletError } from "../keyManager";

type Step =
  "loading" | "welcome" | "device" | "import" | "backup" | "existing" | "signing" | "failed";

export default function Onboarding({ returnTo }: { returnTo?: string }) {
  const router = useRouter();
  const session = useSession();
  const walletState = useSyncExternalStore(keyManager.subscribe, keyManager.getState);
  const [step, setStep] = useState<Step>("loading");
  const [choice, setChoice] = useState<"create" | "import">("create");
  const [deviceSecure, setDeviceSecure] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [importKey, setImportKey] = useState("");
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);
  const [lastFour, setLastFour] = useState("");
  const [address, setAddress] = useState<Address | null>(null);
  const [discard, setDiscard] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedKey = useRef("");
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const foreground = useRef(true);
  const lifecycle = useRef(0);
  const pendingOperations = useRef(new Set<object>());
  const active = useCallback(
    (generation: number) =>
      mounted.current && foreground.current && lifecycle.current === generation,
    [],
  );
  const cancelPending = useCallback(() => {
    lifecycle.current++;
    if (pendingOperations.current.size) keyManager.lock();
  }, []);

  const clearClipboard = useCallback(() => {
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    const expected = copiedKey.current;
    copiedKey.current = "";
    if (expected) void platform.clearCopiedText(expected).catch(() => {});
  }, []);
  const clearSecrets = useCallback(() => {
    setPrivateKey("");
    setImportKey("");
    setShow(false);
    setLastFour("");
    setSaved(false);
    setCopied(false);
    clearClipboard();
  }, [clearClipboard]);

  useEffect(() => {
    mounted.current = true;
    let unsubscribe: Unsubscribe | undefined;
    let resume: Unsubscribe | undefined;
    void platform
      .onResume(() => {
        foreground.current = true;
        // A paused write may still be settling. Reconcile its durable result
        // before allowing another mutation or navigation within onboarding.
        setBusy(pendingOperations.current.size > 0);
        setStep((current) => (current === "signing" ? "existing" : current));
        const generation = lifecycle.current;
        void keyManager
          .hasWallet()
          .then(async (exists) => {
            if (!exists) return;
            const needsBackup = await keyManager.backupRequired();
            const ownAddress = await keyManager.address();
            if (active(generation)) {
              setAddress(ownAddress);
              setStep(needsBackup ? "backup" : "existing");
            }
          })
          .catch(() => {})
          .finally(() => {
            if (active(generation)) setBusy(false);
          });
      })
      .then((off) => {
        if (mounted.current) resume = off;
        else void off();
      })
      .catch(() => {});
    void platform
      .onPause(() => {
        foreground.current = false;
        lifecycle.current++;
        clearSecrets();
        keyManager.lock();
      })
      .then((off) => {
        if (mounted.current) unsubscribe = off;
        else void off();
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      cancelPending();
      clearClipboard();
      void unsubscribe?.();
      void resume?.();
    };
  }, [active, cancelPending, clearSecrets, clearClipboard]);
  useEffect(() => {
    if (walletState !== "unlocked") clearSecrets();
  }, [walletState, clearSecrets]);
  useEffect(() => {
    let initialActive = true;
    const generation = lifecycle.current;
    void (async () => {
      const exists = await keyManager.hasWallet();
      const needsBackup = exists && (await keyManager.backupRequired());
      const ownAddress = exists ? await keyManager.address() : null;
      if (!initialActive || !active(generation)) return;
      setAddress(ownAddress);
      setStep(needsBackup ? "backup" : exists ? "existing" : "welcome");
    })().catch(() => {
      if (initialActive && active(generation)) {
        setError("The device wallet could not be opened. Try again.");
        setStep("failed");
      }
    });
    return () => {
      initialActive = false;
    };
  }, [active]);
  useEffect(() => {
    if (
      !busy &&
      session.data &&
      walletState === "unlocked" &&
      mounted.current &&
      foreground.current
    )
      router.replace(safeReturnTo(returnTo));
  }, [busy, session.data, walletState, returnTo, router]);

  function fail(reason: unknown) {
    setError(
      reason instanceof WalletError
        ? reason.message
        : "Could not complete wallet sign-in. Check your connection and try again.",
    );
  }
  async function checkDevice(nextChoice: "create" | "import") {
    const generation = lifecycle.current;
    setChoice(nextChoice);
    setStep("device");
    setError("");
    setDeviceSecure(null);
    try {
      const security = await platform.biometric.isAvailable();
      if (active(generation)) setDeviceSecure(security.deviceSecure);
    } catch {
      if (active(generation)) setError("Could not check your screen lock. Try again.");
    }
  }
  async function createWallet() {
    const generation = lifecycle.current;
    const operation = {};
    pendingOperations.current.add(operation);
    setBusy(true);
    setError("");
    try {
      const result = await keyManager.create();
      if (!active(generation)) return;
      setAddress(result.address);
      setStep("backup");
      if (!active(generation)) return;
      await keyManager.unlock();
      if (!active(generation)) return;
      setAddress(result.address);
      setPrivateKey(result.privateKey);
      setStep("backup");
    } catch (reason) {
      if (active(generation)) fail(reason);
    } finally {
      pendingOperations.current.delete(operation);
      if (active(generation)) setBusy(false);
    }
  }
  async function showBackup() {
    const generation = lifecycle.current;
    const operation = {};
    pendingOperations.current.add(operation);
    setBusy(true);
    setError("");
    try {
      await keyManager.unlock();
      if (!active(generation)) return;
      const key = await keyManager.revealPrivateKey();
      if (active(generation) && keyManager.getState() === "unlocked") setPrivateKey(key);
    } catch (reason) {
      if (active(generation)) fail(reason);
    } finally {
      pendingOperations.current.delete(operation);
      if (active(generation)) setBusy(false);
    }
  }
  async function signIn(generation = lifecycle.current) {
    if (!active(generation)) return;
    const operation = {};
    pendingOperations.current.add(operation);
    clearSecrets();
    setStep("signing");
    setBusy(true);
    setError("");
    try {
      await resumeNativeSession(() => active(generation));
      if (active(generation)) {
        pendingOperations.current.delete(operation);
        router.replace(safeReturnTo(returnTo));
      }
    } catch (reason) {
      if (active(generation)) {
        fail(reason);
        setStep("failed");
      }
    } finally {
      pendingOperations.current.delete(operation);
      if (active(generation)) setBusy(false);
    }
  }
  async function importWallet() {
    const generation = lifecycle.current;
    const operation = {};
    pendingOperations.current.add(operation);
    setBusy(true);
    setError("");
    try {
      const result = await keyManager.importKey(importKey);
      if (!active(generation)) return;
      setAddress(result.address);
      setImportKey("");
      pendingOperations.current.delete(operation);
      if (active(generation)) await signIn(generation);
    } catch (reason) {
      if (active(generation)) fail(reason);
    } finally {
      pendingOperations.current.delete(operation);
      if (active(generation)) setBusy(false);
    }
  }
  async function finishBackup() {
    const generation = lifecycle.current;
    const operation = {};
    if (!saved || !address || !privateKey || lastFour.trim().toLowerCase() !== privateKey.slice(-4))
      return;
    pendingOperations.current.add(operation);
    setBusy(true);
    setError("");
    try {
      await keyManager.completeBackup(address, lastFour);
      pendingOperations.current.delete(operation);
      if (active(generation)) await signIn(generation);
    } catch (reason) {
      if (active(generation)) fail(reason);
    } finally {
      pendingOperations.current.delete(operation);
      if (active(generation)) setBusy(false);
    }
  }
  const askDiscard = useCallback(() => {
    if (!busy && !pendingOperations.current.size) setDiscard(true);
  }, [busy]);
  const backToWelcome = useCallback(() => {
    // Back is consumed while secure storage/sign-in is pending. Once idle,
    // changing steps also invalidates any outstanding device discovery.
    if (busy || pendingOperations.current.size) return;
    cancelPending();
    clearSecrets();
    setStep("welcome");
  }, [busy, cancelPending, clearSecrets]);
  useBackHandler(step === "backup", askDiscard);
  useBackHandler(step === "device" || step === "import", backToWelcome);

  return (
    <main className="contact-page section">
      <span className="wordmark">PingApp</span>
      <div
        className="card settings-card"
        style={{ maxWidth: 460, margin: "28px auto", display: "grid", gap: 18, minWidth: 0 }}
      >
        {error && <p role="alert">{error}</p>}
        {step === "loading" && <p role="status">Opening your wallet…</p>}
        {step === "welcome" && (
          <>
            <h1 style={{ fontSize: 34 }}>Your wallet. Your phone.</h1>
            <p>Your PingApp wallet lives on this phone.</p>
            <button className="button accent" onClick={() => void checkDevice("create")}>
              Create new wallet
            </button>
            <button className="button outline" onClick={() => void checkDevice("import")}>
              I already have a private key
            </button>
            <p className="field-help">
              PingApp never sees your key. If you lose this phone without a backup, your funds are
              gone.
            </p>
          </>
        )}
        {step === "device" && (
          <>
            <h1 style={{ fontSize: 30 }}>
              {deviceSecure === false ? "Set a screen lock first" : "Protect your wallet"}
            </h1>
            <p>
              {deviceSecure === false
                ? "Open your phone’s Settings and set a PIN, password or screen lock. Then return here."
                : "A device screen lock is required to keep your wallet safe."}
            </p>
            {deviceSecure === null && <p role="status">Checking your device…</p>}
            {deviceSecure === true && <p role="status">Your device has a screen lock.</p>}
            {deviceSecure === false && (
              <button
                className="button accent"
                onClick={() =>
                  void platform
                    .openSecuritySettings()
                    .catch(() =>
                      setError(
                        "Open your device Settings → Security and set a screen lock, then return here.",
                      ),
                    )
                }
              >
                Open settings
              </button>
            )}
            <button
              className="button outline"
              disabled={busy}
              onClick={() => void checkDevice(choice)}
            >
              Check again
            </button>
            <button
              className="button accent"
              disabled={busy || deviceSecure !== true}
              onClick={() => (choice === "create" ? void createWallet() : setStep("import"))}
            >
              {busy ? "Creating wallet…" : "Continue"}
            </button>
            <button className="text-link" disabled={busy} onClick={backToWelcome}>
              Back
            </button>
          </>
        )}
        {step === "import" && (
          <>
            <h1 style={{ fontSize: 30 }}>Import your private key</h1>
            <p>Use your own backup. Your key stays on this phone.</p>
            <label>
              Private key
              <input
                className="input"
                type={show ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                value={importKey}
                onChange={(event) => setImportKey(event.target.value)}
              />
            </label>
            <button className="button outline" onClick={() => setShow(!show)}>
              {show ? "Hide" : "Show"}
            </button>
            <button
              className="button accent"
              disabled={busy || !importKey.trim()}
              onClick={() => void importWallet()}
            >
              Continue
            </button>
            <button className="text-link" disabled={busy} onClick={backToWelcome}>
              Back
            </button>
          </>
        )}
        {step === "backup" && (
          <>
            <h1 style={{ fontSize: 30 }}>Back up your wallet</h1>
            <p>
              Save your private key before continuing. This is your only way to recover your wallet.
            </p>
            <ul style={{ paddingLeft: 20 }}>
              <li>Anyone with this key controls your funds.</li>
              <li>Store it offline in a safe place.</li>
              <li>PingApp support can never recover it.</li>
            </ul>
            {privateKey ? (
              <>
                <div
                  aria-label="Private key backup"
                  style={{
                    fontFamily: "monospace",
                    overflowWrap: "anywhere",
                    padding: 16,
                    background: "#11151d",
                    borderRadius: 10,
                  }}
                >
                  {show ? privateKey : "•••• •••• •••• •••• •••• •••• •••• ••••"}
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="button outline" onClick={() => setShow(!show)}>
                    {show ? "Hide" : "Show"}
                  </button>
                  <button
                    className="button outline"
                    onClick={() => {
                      const generation = lifecycle.current;
                      void platform
                        .copyText(privateKey)
                        .then(() => {
                          if (!active(generation)) {
                            void platform.clearCopiedText(privateKey).catch(() => {});
                            return;
                          }
                          if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
                          copiedKey.current = privateKey;
                          setCopied(true);
                          clipboardTimer.current = setTimeout(() => {
                            clearClipboard();
                            if (mounted.current) setCopied(false);
                          }, 60_000);
                        })
                        .catch(() =>
                          setError("Could not copy the key. Save it offline from this screen."),
                        );
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="field-help">
                  Copied keys clear after 60 seconds when the clipboard still holds this key.
                </p>
              </>
            ) : (
              <button className="button outline" disabled={busy} onClick={() => void showBackup()}>
                Resume backup
              </button>
            )}
            <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              I saved my private key
            </label>
            <label>
              Type the last 4 characters of your key
              <input
                className="input"
                autoComplete="off"
                maxLength={4}
                spellCheck={false}
                value={lastFour}
                onChange={(event) => setLastFour(event.target.value)}
              />
            </label>
            <button
              className="button accent"
              disabled={
                busy ||
                !saved ||
                !privateKey ||
                lastFour.trim().toLowerCase() !== privateKey.slice(-4)
              }
              onClick={() => void finishBackup()}
            >
              Continue
            </button>
            <button className="text-link" disabled={busy} onClick={askDiscard}>
              Back
            </button>
          </>
        )}
        {step === "existing" && (
          <>
            <h1 style={{ fontSize: 30 }}>Welcome back</h1>
            <p>Your wallet is saved on this phone.</p>
            <button className="button accent" disabled={busy} onClick={() => void signIn()}>
              Continue with my wallet
            </button>
          </>
        )}
        {step === "signing" && (
          <>
            <h1 style={{ fontSize: 30 }}>Signing in…</h1>
            <p role="status">
              Opening your private workspace. This moves no funds and costs no gas.
            </p>
          </>
        )}
        {step === "failed" && (
          <>
            <h1 style={{ fontSize: 30 }}>Sign-in needs another try</h1>
            <button className="button accent" disabled={busy} onClick={() => void signIn()}>
              Retry
            </button>
            <p>
              Before removing an imported wallet, make sure you have its private key backed up.
              Removing it does not recover or move funds.
            </p>
            <button className="button outline" disabled={busy} onClick={() => setDiscard(true)}>
              Remove wallet from this device
            </button>
          </>
        )}
      </div>
      <AlertDialog open={discard} onOpenChange={setDiscard}>
        <AlertDialogContent>
          <AlertDialogTitle>
            {step === "backup" ? "Leave without backing up?" : "Remove this wallet?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {step === "backup"
              ? "Your wallet will be deleted. Keep your backup before continuing if you have sent funds to it."
              : "Make sure you have exported your private key first. Your saved wallet and device session will be removed."}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep wallet</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                setBusy(true);
                clearSecrets();
                void removeNativeWallet()
                  .then(() => {
                    setDiscard(false);
                    setStep("welcome");
                    setAddress(null);
                    setError("");
                  })
                  .catch(fail)
                  .finally(() => setBusy(false));
              }}
            >
              Delete wallet from device
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
