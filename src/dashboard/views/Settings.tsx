import { ArrowUpRight, Check, Wallet } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useDashboard } from "../state";
import Connection from "../components/Connection";
import { useAuth } from "../../auth/useAuth";
import { openAccount } from "../../wallet/appkit";

export default function Settings() {
  const { name, setName, confirm, setConfirm, busy, setBusy, saveProfile, wallet } = useDashboard();
  const { me } = useAuth();

  return (
    <div className="settings-grid">
      <section className="card settings-card">
        <h2>Your profile</h2>
        <p>Your account details and transfer preferences.</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await saveProfile({ display_name: name, confirm_transfers: confirm ? 1 : 0 });
              toast.success("Settings saved");
            } catch (error) {
              toast.error((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Display name
            <input
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
            />
          </label>
          <div className="setting-switch">
            <span>
              <strong>Keep transfer reminders visible</strong>
              <small>A reminder to check the recipient before sending.</small>
            </span>
            <Switch
              checked={confirm}
              onCheckedChange={setConfirm}
              aria-label="Transfer reminders"
            />
          </div>
          <button disabled={busy} className="button accent">
            {busy ? "Saving…" : "Save changes"}
            <Check size={16} />
          </button>
        </form>
      </section>
      <div>
        <section className="card settings-card">
          <h2>Wallet connection</h2>
          <p>Your address is public. Your keys stay private.</p>
          <div className="settings-address">{me?.address || wallet}</div>
          <Connection />
          <div className="settings-buttons">
            <button className="button outline" disabled={busy} onClick={() => void openAccount()}>
              Manage wallet
              <Wallet size={15} />
            </button>
          </div>
        </section>
        <section className="card settings-card">
          <h2>Phone verification</h2>
          <span className="pill">Not connected</span>
          <p>
            Phone registration needs PingApp’s verification service. Your saved contacts remain
            available while that service is not connected.
          </p>
          <a className="text-link" href="/what-we-do/security">
            How verification works <ArrowUpRight size={15} />
          </a>
        </section>
        <a className="back-site" href="/logout" target="_top">
          Sign out of PingApp <ArrowUpRight size={15} />
        </a>
      </div>
    </div>
  );
}
