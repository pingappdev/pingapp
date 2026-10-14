import { useEffect, useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { localApproval } from "./localApproval";

export default function LocalApprovalDialog() {
  const approval = useSyncExternalStore(localApproval.subscribe, localApproval.getSnapshot);
  useEffect(() => () => localApproval.cancel(), []);
  return (
    <AlertDialog
      open={!!approval}
      onOpenChange={(open) => {
        if (!open) localApproval.cancel();
      }}
    >
      {approval && (
        <AlertDialogContent>
          <AlertDialogTitle>{approval.reason}</AlertDialogTitle>
          <AlertDialogDescription>
            Your device has no screen lock. This confirmation does not verify your identity.
            Continue only if you requested this action.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => localApproval.finish(approval.id, false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                localApproval.finish(approval.id, true);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
