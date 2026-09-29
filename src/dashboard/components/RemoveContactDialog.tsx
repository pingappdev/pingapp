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
import { workspaceApi as api } from "../../lib/workspace";
import { useDashboard } from "../state";

export default function RemoveContactDialog() {
  const { remove, setRemove, load } = useDashboard();

  return (
    <AlertDialog
      open={!!remove}
      onOpenChange={(open) => {
        if (!open) setRemove(null);
      }}
    >
      <AlertDialogContent className="workspace-alert">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {remove?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the saved contact from your account. It does not affect their wallet or any
            transactions.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep contact</AlertDialogCancel>
          <AlertDialogAction
            onClick={async () => {
              try {
                await api({ action: "delete-contact", id: remove?.id });
                await load();
                setRemove(null);
                toast.success("Contact removed");
              } catch (error) {
                toast.error((error as Error).message);
              }
            }}
          >
            Remove contact
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
