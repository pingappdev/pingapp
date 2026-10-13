import { ArrowUpRight, Check, Wallet } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "../../api/client";
import { useUpdateMe } from "../../api/hooks";
import { useAuth } from "../../auth/useAuth";
import { explorerAddress } from "../../config";
import AddressText from "../components/AddressText";
import PhoneLinkFlow from "../components/PhoneLinkFlow";
import { openAccount } from "../../wallet/appkit";
import DeleteAccountCard from "./settings/DeleteAccountCard";
import SessionsCard from "./settings/SessionsCard";

const NativeWalletSection =
  import.meta.env.VITE_TARGET === "native" ? lazy(() => import("./settings/WalletSection")) : null;

export default function Settings() {
  const { me } = useAuth();
  const updateMe = useUpdateMe();
  const [name, setName] = useState(me?.displayName ?? "");
  const [nameError, setNameError] = useState("");
  const profileName = me?.displayName ?? "";

  useEffect(() => {
    setName(profileName);
  }, [profileName]);

  if (!me) return null;

  return (
    <div className="settings-grid">
      <section className="card settings-card">
        <h2>Your profile</h2>
        <p>Manage the name people see when they send to your number.</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setNameError("");
            try {
              await updateMe.mutateAsync({ displayName: name.trim() });
              toast.success("Profile updated");
            } catch (error) {
              if (error instanceof ApiError && error.code === "VALIDATION") {
                setNameError(error.message);
              } else {
                toast.error((error as Error).message || "Could not save your profile.");
              }
            }
          }}
        >
          <label>
            Display name
            <input
              className="auth-input"
              maxLength={40}
              value={name}
              disabled={updateMe.isPending}
              onChange={(event) => {
                setName(event.target.value);
                setNameError("");
              }}
              placeholder="Your name"
            />
          </label>
          <p className="field-help">
            Shown to people who send to your number, and in SMS invites you send.
          </p>
          {nameError && (
            <p className="field-help" role="alert">
              {nameError}
            </p>
          )}
          <button disabled={updateMe.isPending} className="button accent">
            {updateMe.isPending ? "Saving…" : "Save changes"}
            <Check size={16} />
          </button>
        </form>

        <div style={{ marginTop: 28 }}>
          <h3 style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>Wallet address</h3>
          <div className="settings-address">
            <AddressText value={me.address} full />
          </div>
          <a
            className="text-link"
            href={explorerAddress(me.address)}
            target="_blank"
            rel="noreferrer"
          >
            View on explorer <ArrowUpRight size={15} />
          </a>
        </div>
      </section>

      <div>
        {NativeWalletSection ? (
          <Suspense fallback={null}>
            <NativeWalletSection address={me.address} />
          </Suspense>
        ) : (
          <section className="card settings-card">
            <h2>Wallet connection</h2>
            <p>Your address is public. Your keys stay private.</p>
            <div className="settings-buttons">
              <button className="button outline" onClick={() => void openAccount()}>
                Manage wallet
                <Wallet size={15} />
              </button>
            </div>
          </section>
        )}
        <section className="card settings-card">
          <h2>Phone verification</h2>
          <PhoneLinkFlow compact />
        </section>
        <SessionsCard />
        <DeleteAccountCard />
        <a className="back-site" href="/logout" target="_top">
          Sign out of PingApp <ArrowUpRight size={15} />
        </a>
      </div>
    </div>
  );
}
