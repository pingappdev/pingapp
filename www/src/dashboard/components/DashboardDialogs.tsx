import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useDashboard } from "../state";
import ReceiveDialog from "./ReceiveDialog";

export default function DashboardDialogs() {
  const { modal, setModal } = useDashboard();

  return (
    <>
      <Dialog
        open={modal === "receive"}
        onOpenChange={(open) => {
          if (!open) setModal("");
        }}
      >
        <DialogContent className="ping-dialog">
          <DialogTitle>Receive in your wallet</DialogTitle>
          <DialogDescription>
            Share your public address. Only receive assets on Robinhood Chain.
          </DialogDescription>
          {modal === "receive" && <ReceiveDialog />}
        </DialogContent>
      </Dialog>
    </>
  );
}
