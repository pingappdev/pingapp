import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useDashboard } from "../state";
import ContactDialog from "./ContactDialog";
import ReceiveDialog from "./ReceiveDialog";
import RemoveContactDialog from "./RemoveContactDialog";
import ReviewDialog from "./ReviewDialog";

export default function DashboardDialogs() {
  const { modal, busy, setModal } = useDashboard();

  return (
    <>
      <Dialog
        open={!!modal}
        onOpenChange={(open) => {
          if (!open && !busy) setModal("");
        }}
      >
        <DialogContent className="ping-dialog">
          <DialogTitle>
            {modal === "contact" ? "Add a contact" : "Receive in your wallet"}
          </DialogTitle>
          <DialogDescription>
            {modal === "contact"
              ? "Save someone you know. Confirm their wallet address before adding it."
              : "Share your public address. Only receive assets on the selected network."}
          </DialogDescription>
          {modal === "contact" && <ContactDialog />}
          {modal === "receive" && <ReceiveDialog />}
        </DialogContent>
      </Dialog>
      <ReviewDialog />
      <RemoveContactDialog />
    </>
  );
}
