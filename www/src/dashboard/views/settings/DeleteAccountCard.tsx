import { useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { useDeleteAccount } from "../../../api/hooks";
import { useAuth } from "../../../auth/useAuth";
import { useDisconnect } from "wagmi";

export default function DeleteAccountCard() {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const deletingInFlight = useRef(false);
  const deleteAccount = useDeleteAccount();
  const { withReauth } = useAuth();
  const { disconnectAsync } = useDisconnect();

  async function deleteUserAccount() {
    if (deletingInFlight.current) return;
    deletingInFlight.current = true;
    setDeleting(true);
    try {
      await withReauth(() => deleteAccount.mutateAsync());
    } catch (error) {
      toast.error((error as Error).message || "Could not delete your account.");
      deletingInFlight.current = false;
      setDeleting(false);
      return;
    }

    try {
      void disconnectAsync().catch(() => undefined);
    } catch {
      // The account is already deleted and its session cookie has been cleared.
    }
    window.location.replace("/");
  }

  return (
    <section className="card settings-card">
      <h2>Delete account</h2>
      <p>
        Permanently delete your PingApp account, phone link, contacts, pending sends, and
        notifications. On-chain transactions are public and can&apos;t be deleted.
      </p>
      <button type="button" className="button outline" onClick={() => setOpen(true)}>
        Delete account
      </button>

      <AlertDialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!deleting && !deleteAccount.isPending) setOpen(nextOpen);
          if (!nextOpen) setConfirmation("");
        }}
      >
        <AlertDialogContent className="workspace-alert">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your PingApp account?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes your phone link, contacts, pending sends, and notifications. Your
              on-chain transactions are public and can&apos;t be deleted. This action can&apos;t be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label>
            Type DELETE to continue
            <input
              className="auth-input"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={deleting || deleteAccount.isPending}
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting || deleteAccount.isPending}>
              Keep account
            </AlertDialogCancel>
            <AlertDialogAction
              className="button accent"
              disabled={confirmation !== "DELETE" || deleting || deleteAccount.isPending}
              onClick={(event) => {
                event.preventDefault();
                void deleteUserAccount();
              }}
            >
              {deleting || deleteAccount.isPending ? "Deleting…" : "Delete account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
