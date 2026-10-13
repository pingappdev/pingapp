import { useEffect, useState } from "react";
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
import { useRemoveContact } from "../../api/hooks";
import type { Contact } from "../../api/types";

export default function RemoveContactDialog({
  contact,
  onClose,
}: {
  contact: Contact | null;
  onClose: () => void;
}) {
  const remove = useRemoveContact();
  const [error, setError] = useState("");
  useEffect(() => setError(""), [contact]);

  async function confirm() {
    if (!contact || remove.isPending) return;
    setError("");
    try {
      await remove.mutateAsync(contact.id);
      toast.success("Contact removed");
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove this contact.");
    }
  }

  return (
    <AlertDialog
      open={!!contact}
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
    >
      <AlertDialogContent className="workspace-alert">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {contact?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the saved contact from your account. It does not affect their wallet or any
            transactions.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="field-help contact-form-error" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Keep contact</AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            {remove.isPending ? "Removing…" : "Remove contact"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
