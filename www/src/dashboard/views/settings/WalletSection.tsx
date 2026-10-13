import { useCallback, useEffect, useRef, useState } from "react";
import { platform, PlatformError, type Unsubscribe } from "@/platform";
import { keyManager, WalletError } from "@/wallet/native/keyManager";
import { authenticateWallet } from "@/wallet/native/lockPolicy";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import AddressText from "../../components/AddressText";
import NativeWalletLifecycleDialog from "./NativeWalletLifecycleDialog";

export default function WalletSection({ address }: { address: string }) {
  const [kind, setKind] = useState("Device screen lock");
  const [step, setStep] = useState<"closed" | "warning" | "approving" | "reveal">("closed");
  const [privateKey, setPrivateKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const generation = useRef(0);
  const phase = useRef(step);
  phase.current = step;
  const copiedKey = useRef("");
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearClipboard = useCallback(() => {
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    const expected = copiedKey.current;
    copiedKey.current = "";
    if (expected) void platform.clearCopiedText(expected).catch(() => {});
  }, []);
  const clear = useCallback(() => {
    generation.current++;
    setPrivateKey("");
    setVisible(false);
    setCopied(false);
    setStep("closed");
    clearClipboard();
  }, [clearClipboard]);

  useEffect(() => {
    mounted.current = true;
    let pause: Unsubscribe | undefined;
    void platform.biometric
      .isAvailable()
      .then((security) => {
        if (mounted.current)
          setKind(
            security.available
              ? `${security.kind[0].toUpperCase()}${security.kind.slice(1)} or device screen lock`
              : "Device screen lock",
          );
      })
      .catch(() => {});
    void platform
      .onPause(clear)
      .then((off) => {
        if (mounted.current) pause = off;
        else void off();
      })
      .catch(() => {});
    const off = keyManager.subscribe(() => {
      if (keyManager.getState() !== "unlocked") clear();
    });
    // Native authentication temporarily moves focus to its system UI. There is
    // no export key yet in that phase; real background still calls clear above.
    const blur = () => {
      if (phase.current !== "approving") clear();
    };
    window.addEventListener("blur", blur);
    const exportRequested = () => {
      setError("");
      setStep("warning");
    };
    window.addEventListener("pingapp:export-wallet", exportRequested);
    return () => {
      mounted.current = false;
      generation.current++;
      clearClipboard();
      off();
      void pause?.();
      window.removeEventListener("blur", blur);
      window.removeEventListener("pingapp:export-wallet", exportRequested);
    };
  }, [clear, clearClipboard]);

  async function exportKey() {
    const expected = generation.current;
    const active = () =>
      mounted.current && generation.current === expected && keyManager.getState() === "unlocked";
    setStep("approving");
    setError("");
    try {
      await authenticateWallet("Export private key", active);
      if (!active()) return;
      phase.current = "reveal";
      const key = await keyManager.revealPrivateKey();
      if (!active()) return;
      setPrivateKey(key);
      setVisible(false);
      setStep("reveal");
    } catch (reason) {
      if (active()) {
        setError(
          reason instanceof WalletError || reason instanceof PlatformError
            ? reason.message
            : "Could not export your key. Try again.",
        );
        setStep("warning");
      }
    }
  }

  async function copyKey() {
    const expected = generation.current;
    const key = privateKey;
    if (!key || keyManager.getState() !== "unlocked") return;
    try {
      await platform.copyText(key);
      if (
        !mounted.current ||
        generation.current !== expected ||
        keyManager.getState() !== "unlocked"
      ) {
        await platform.clearCopiedText(key);
        return;
      }
      if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
      copiedKey.current = key;
      setCopied(true);
      clipboardTimer.current = setTimeout(() => {
        clearClipboard();
        if (mounted.current) setCopied(false);
      }, 60_000);
    } catch {
      if (mounted.current && generation.current === expected)
        setError("Could not copy your key. Try again.");
    }
  }

  return (
    <section id="wallet" className="card settings-card">
      <h2>Wallet</h2>
      <p>Stored on this device</p>
      <div className="settings-address">
        <AddressText value={address} full />
      </div>
      <p className="field-help">Protected with {kind.toLowerCase()}.</p>
      <div className="settings-buttons">
        <button
          className="button outline"
          onClick={() => {
            setError("");
            setStep("warning");
          }}
        >
          Export private key
        </button>
        <button className="button outline" onClick={() => keyManager.lock()}>
          Lock now
        </button>
      </div>
      <NativeWalletLifecycleDialog action="remove" onExport={() => {
        setError("");
        setStep("warning");
      }} />
      <Dialog
        open={step !== "closed"}
        onOpenChange={(open) => {
          if (!open) clear();
        }}
      >
        <DialogContent>
          <DialogTitle>{step === "reveal" ? "Your private key" : "Export private key"}</DialogTitle>
          <DialogDescription>
            {step === "reveal"
              ? "Save it offline in a safe place. Anyone with this key controls your funds."
              : "Anyone with this key controls your funds. Never share it with PingApp support or paste it into websites."}
          </DialogDescription>
          {error && <p role="alert">{error}</p>}
          {step === "warning" && (
            <button className="button accent" onClick={() => void exportKey()}>
              Continue to export
            </button>
          )}
          {step === "approving" && <p role="status">Approve on your device…</p>}
          {step === "reveal" && (
            <>
              <div
                aria-label="Private key"
                style={{
                  fontFamily: "monospace",
                  overflowWrap: "anywhere",
                  padding: 16,
                  background: "#11151d",
                  borderRadius: 10,
                }}
              >
                {visible ? privateKey : "•••• •••• •••• •••• •••• •••• •••• ••••"}
              </div>
              <div className="settings-buttons">
                <button className="button outline" onClick={() => setVisible(!visible)}>
                  {visible ? "Hide" : "Tap to reveal"}
                </button>
                <button className="button outline" onClick={() => void copyKey()}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="field-help">
                Copied keys clear after 60 seconds if the clipboard still holds this key.
              </p>
              <button className="button accent" onClick={clear}>
                Done
              </button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
