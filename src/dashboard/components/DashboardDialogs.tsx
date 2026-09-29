import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useDashboard } from "../state";
import ReceiveDialog from "./ReceiveDialog";

export default function DashboardDialogs() {
  const { modal, busy, setModal } = useDashboard();

  return (
    <>
      <Dialog
        open={modal === "receive"}
        onOpenChange={(open) => {
          if (!open && !busy) setModal("");
        }}
      >
        <DialogContent className="ping-dialog">
          <DialogTitle>Receive in your wallet</DialogTitle>
          <DialogDescription>
            Share your public address. Only receive assets on the selected network.
          </DialogDescription>
          {modal === "receive" && <ReceiveDialog />}
        </DialogContent>
      </Dialog>
    </>
  );
}
