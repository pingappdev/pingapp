import { Plus } from "lucide-react";
import { toast } from "sonner";
import { useDashboard } from "../state";
import { workspaceApi as api } from "../../lib/workspace";

export default function ContactDialog() {
  const { busy, setBusy, load, setModal } = useDashboard();

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const form = new FormData(event.currentTarget);
        try {
          await api({
            action: "contact",
            name: form.get("name"),
            phone: String(form.get("phone")).replace(/[\s()-]/g, ""),
            address: String(form.get("address")).trim(),
          });
          await load();
          setModal("");
          toast.success("Contact saved");
        } catch (error) {
          toast.error((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Name
        <input name="name" required maxLength={80} placeholder="Contact name" />
      </label>
      <label>
        Phone number
        <input name="phone" type="tel" required placeholder="+60 12 345 6789" />
      </label>
      <label>
        Wallet address
        <input name="address" required pattern="0x[a-fA-F0-9]{40}" placeholder="0x…" />
      </label>
      <p className="field-help">
        Saved privately in your account. This does not verify phone ownership.
      </p>
      <button className="button accent" disabled={busy}>
        {busy ? "Saving…" : "Save contact"}
        <Plus size={16} />
      </button>
    </form>
  );
}
