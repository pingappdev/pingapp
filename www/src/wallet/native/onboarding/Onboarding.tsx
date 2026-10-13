import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { useSession } from "@/api/hooks";
import { safeReturnTo } from "@/auth/return-to";
import { removeNativeWallet, resumeNativeSession } from "@/auth/nativeSession";
import { platform, type Unsubscribe } from "@/platform";
import { useBackHandler } from "@/platform/backHandlerStack";
import { useRouter } from "@/routing";
import {
  AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { keyManager, WalletError } from "../keyManager";

type Step = "loading" | "welcome" | "device" | "import" | "backup" | "existing" | "signing" | "failed";

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

  const clearClipboard = useCallback(() => {
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    const expected = copiedKey.current;
    copiedKey.current = "";
    if (expected) void platform.clearCopiedText(expected).catch(() => {});
  }, []);
  const clearSecrets = useCallback(() => {
    setPrivateKey(""); setImportKey(""); setShow(false); setLastFour(""); setSaved(false);
    clearClipboard();
  }, [clearClipboard]);

  useEffect(() => {
    mounted.current = true;
    let unsubscribe: Unsubscribe | undefined;
    void platform.onPause(() => { clearSecrets(); keyManager.lock(); })
      .then((off) => { if (mounted.current) unsubscribe = off; else void off(); }).catch(() => {});
    return () => { mounted.current = false; clearClipboard(); void unsubscribe?.(); };
  }, [clearSecrets, clearClipboard]);
  useEffect(() => {
    if (walletState !== "unlocked") clearSecrets();
  }, [walletState, clearSecrets]);
  useEffect(() => {
    let active = true;
    void (async () => {
      const exists = await keyManager.hasWallet();
      const needsBackup = exists && await keyManager.backupRequired();
      const ownAddress = exists ? await keyManager.address() : null;
      if (!active) return;
      setAddress(ownAddress);
      setStep(needsBackup ? "backup" : exists ? "existing" : "welcome");
    })().catch(() => { if (active) { setError("The device wallet could not be opened. Try again."); setStep("failed"); } });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (session.data && walletState === "unlocked") router.replace(safeReturnTo(returnTo));
  }, [session.data, walletState, returnTo, router]);

  function fail(reason: unknown) {
    setError(reason instanceof WalletError ? reason.message : "Could not complete wallet sign-in. Check your connection and try again.");
  }
  async function checkDevice(nextChoice: "create" | "import") {
    setChoice(nextChoice); setStep("device"); setError(""); setDeviceSecure(null);
    try { setDeviceSecure((await platform.biometric.isAvailable()).deviceSecure); }
    catch { setError("Could not check your screen lock. Try again."); }
  }
  async function createWallet() {
    setBusy(true); setError("");
    try {
      const result = await keyManager.create();
      await keyManager.unlock();
      if (!mounted.current) return keyManager.lock();
      setAddress(result.address); setPrivateKey(result.privateKey); setStep("backup");
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  }
  async function showBackup() {
    setBusy(true); setError("");
    try {
      await keyManager.unlock();
      const key = await keyManager.revealPrivateKey();
      if (mounted.current && keyManager.getState() === "unlocked") setPrivateKey(key);
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  }
  async function signIn() {
    clearSecrets(); setStep("signing"); setBusy(true); setError("");
    try { await resumeNativeSession(); router.replace(safeReturnTo(returnTo)); }
    catch (reason) { if (mounted.current) { fail(reason); setStep("failed"); } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function importWallet() {
    setBusy(true); setError("");
    try {
      const result = await keyManager.importKey(importKey);
      setAddress(result.address); setImportKey(""); await signIn();
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  }
  async function finishBackup() {
    if (!saved || !address || !privateKey || lastFour.trim().toLowerCase() !== privateKey.slice(-4)) return;
    setBusy(true); setError("");
    try { await keyManager.completeBackup(address, lastFour); await signIn(); }
    catch (reason) { fail(reason); } finally { setBusy(false); }
  }
  const askDiscard = useCallback(() => { if (!busy) setDiscard(true); }, [busy]);
  useBackHandler(step === "backup", askDiscard);
  useBackHandler(step === "device" || step === "import", () => { clearSecrets(); setStep("welcome"); });

  return (
    <main className="contact-page section">
      <span className="wordmark">PingApp</span>
      <div className="card settings-card" style={{ maxWidth: 460, margin: "28px auto", display: "grid", gap: 18, minWidth: 0 }}>
        {error && <p role="alert">{error}</p>}
        {step === "loading" && <p role="status">Opening your wallet…</p>}
        {step === "welcome" && <>
          <h1 style={{ fontSize: 34 }}>Your wallet. Your phone.</h1>
          <p>Your PingApp wallet lives on this phone.</p>
          <button className="button accent" onClick={() => void checkDevice("create")}>Create new wallet</button>
          <button className="button outline" onClick={() => void checkDevice("import")}>I already have a private key</button>
          <p className="field-help">PingApp never sees your key. If you lose this phone without a backup, your funds are gone.</p>
        </>}
        {step === "device" && <>
          <h1 style={{ fontSize: 30 }}>{deviceSecure === false ? "Set a screen lock first" : "Protect your wallet"}</h1>
          <p>{deviceSecure === false ? "Open your phone’s Settings and set a PIN, password or screen lock. Then return here." : "A device screen lock is required to keep your wallet safe."}</p>
          {deviceSecure === null && <p role="status">Checking your device…</p>}
          {deviceSecure === true && <p role="status">Your device has a screen lock.</p>}
          {deviceSecure === false && <button className="button accent" onClick={() => void platform.openSecuritySettings().catch(() => setError("Open your device Settings → Security and set a screen lock, then return here."))}>Open settings</button>}
          <button className="button outline" onClick={() => void checkDevice(choice)}>Check again</button>
          <button className="button accent" disabled={busy || deviceSecure !== true} onClick={() => choice === "create" ? void createWallet() : setStep("import")}>{busy ? "Creating wallet…" : "Continue"}</button>
          <button className="text-link" onClick={() => setStep("welcome")}>Back</button>
        </>}
        {step === "import" && <>
          <h1 style={{ fontSize: 30 }}>Import your private key</h1>
          <p>Use your own backup. Your key stays on this phone.</p>
          <label>Private key<input className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} autoCapitalize="none" value={importKey} onChange={(event) => setImportKey(event.target.value)} /></label>
          <button className="button outline" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
          <button className="button accent" disabled={busy || !importKey.trim()} onClick={() => void importWallet()}>Continue</button>
          <button className="text-link" onClick={() => { clearSecrets(); setStep("welcome"); }}>Back</button>
        </>}
        {step === "backup" && <>
          <h1 style={{ fontSize: 30 }}>Back up your wallet</h1>
          <p>Save your private key before continuing. This is your only way to recover your wallet.</p>
          <ul style={{ paddingLeft: 20 }}><li>Anyone with this key controls your funds.</li><li>Store it offline in a safe place.</li><li>PingApp support can never recover it.</li></ul>
          {privateKey ? <>
            <div aria-label="Private key backup" style={{ fontFamily: "monospace", overflowWrap: "anywhere", padding: 16, background: "#11151d", borderRadius: 10 }}>{show ? privateKey : "•••• •••• •••• •••• •••• •••• •••• ••••"}</div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="button outline" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
              <button className="button outline" onClick={() => {
                void platform.copyText(privateKey).then(() => {
                  clearClipboard(); copiedKey.current = privateKey; setCopied(true);
                  clipboardTimer.current = setTimeout(() => { clearClipboard(); if (mounted.current) setCopied(false); }, 60_000);
                }).catch(() => setError("Could not copy the key. Save it offline from this screen."));
              }}>{copied ? "Copied" : "Copy"}</button>
            </div>
            <p className="field-help">Copied keys clear after 60 seconds when the clipboard still holds this key.</p>
          </> : <button className="button outline" disabled={busy} onClick={() => void showBackup()}>Resume backup</button>}
          <label style={{ display: "flex", gap: 10, alignItems: "center" }}><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />I saved my private key</label>
          <label>Type the last 4 characters of your key<input className="input" autoComplete="off" maxLength={4} spellCheck={false} value={lastFour} onChange={(event) => setLastFour(event.target.value)} /></label>
          <button className="button accent" disabled={busy || !saved || !privateKey || lastFour.trim().toLowerCase() !== privateKey.slice(-4)} onClick={() => void finishBackup()}>Continue</button>
          <button className="text-link" disabled={busy} onClick={askDiscard}>Back</button>
        </>}
        {step === "existing" && <>
          <h1 style={{ fontSize: 30 }}>Welcome back</h1><p>Your wallet is saved on this phone.</p>
          <button className="button accent" disabled={busy} onClick={() => void signIn()}>Continue with my wallet</button>
        </>}
        {step === "signing" && <><h1 style={{ fontSize: 30 }}>Signing in…</h1><p role="status">Opening your private workspace. This moves no funds and costs no gas.</p></>}
        {step === "failed" && <>
          <h1 style={{ fontSize: 30 }}>Sign-in needs another try</h1>
          <button className="button accent" disabled={busy} onClick={() => void signIn()}>Retry</button>
          <p>Before removing an imported wallet, make sure you have its private key backed up. Removing it does not recover or move funds.</p>
          <button className="button outline" disabled={busy} onClick={() => setDiscard(true)}>Remove wallet from this device</button>
        </>}
      </div>
      <AlertDialog open={discard} onOpenChange={setDiscard}>
        <AlertDialogContent><AlertDialogTitle>{step === "backup" ? "Leave without backing up?" : "Remove this wallet?"}</AlertDialogTitle>
          <AlertDialogDescription>{step === "backup" ? "Your wallet will be deleted. Keep your backup before continuing if you have sent funds to it." : "Make sure you have exported your private key first. Your saved wallet and device session will be removed."}</AlertDialogDescription>
          <AlertDialogFooter><AlertDialogCancel>Keep wallet</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={(event) => {
            event.preventDefault(); setBusy(true); clearSecrets();
            void removeNativeWallet().then(() => { setDiscard(false); setStep("welcome"); setAddress(null); setError(""); })
              .catch(fail).finally(() => setBusy(false));
          }}>Delete wallet from device</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
